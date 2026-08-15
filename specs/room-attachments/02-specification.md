---
slug: room-attachments
number: 260806-215028
created: 2026-08-07
status: specified
---

# File attachments in rooms

**Status:** Draft
**Author:** flow agent (SPECIFY stage, DOR-947)
**Date:** 2026-08-07
**Design record:** [design-decisions.md](./design-decisions.md) (locked 2026-08-06 with Dorian) · program answers locked at the 2026-08-07 spec review

## Overview

Add files to a room the same way you add them to a chat — paperclip, drag, or paste — and post them
with your message. The files ride the entry as **structured references, never as text spliced into
the body**: the composer uploads them first, the post names them by id, and the server binds them to
the entry in the same transaction that writes it. Members see images inline and everything else as a
calm chip they can download. Every agent the entry triggers gets the files handed to it as readable
paths in its own working directory, with no approval step in between.

Three shipped pieces make this small: DOR-946 left the attach slot reserved on the shared composer
(`Composer.Root`'s `onFilesDropped`, `Composer.Input`'s `onAttach`, `Composer.Attachments`, and the
`PendingFile` type all exist and are unwired in rooms); DOR-976 established the storage pattern for a
permanent, per-install file behind a swappable store seam (`AvatarStore`); and the reaction roll-up
established how a side table's rows reach a reader attached to the entry they belong to.

## Background / Problem Statement

Attachments are chat-only today, and the way chat does it does not transfer.

- **Chat folds files into the prompt text.** `ChatPanel.fileTransformContent` uploads on submit, then
  prepends `Please read the following uploaded file(s):\n- <relative path>\n\n` to the message
  (`apps/client/src/layers/features/chat/ui/ChatPanel.tsx:88-101`, ADR-0100). A room cannot do this
  for two independent reasons. First, `.claude/rules/room-conduct.md` and
  `room-turn-runner.ts:212` hold the prompt to be the message **byte for byte** — everything else
  rides `additionalContext` (ADR-0273). Second, mention spans are UTF-16 offsets into the raw body
  (`MentionSpanSchema`), resolved once at write time; a prefix would move every offset in the entry
  and re-point every pill.
- **Chat's upload endpoint is cwd-scoped.** `POST /api/uploads?cwd=…` writes into
  `{cwd}/.dork/.temp/uploads/` (`upload-handler.ts`) and serves back out of the same directory with
  the caller naming the `cwd`. A room has no cwd. It has N agent members with N different working
  directories and human members with none, which is exactly the failure ADR-0100 listed as its own
  known negative: _"If the agent's cwd differs from the upload cwd, relative paths may not resolve
  correctly."_
- **There is no field to put them in.** `RoomEntrySchema` (`packages/shared/src/room-schemas.ts:613`)
  carries body, mentions, mention spans, thread pointers, cascade provenance and reactions — and
  nothing for a file. `room_entries` has no such column either.

So a person who wants to show a screenshot to the agents in a room today has to paste a filesystem
path and hope every agent can reach it.

Verified against this branch's base, `origin/main` @ `ec423e8e9` (2026-08-07), which includes the
shipped DOR-946 composer-parity slice.

## Goals

- Files reach a room through the **same composer affordances chat has** — the paperclip button, drag
  onto the card, and paste — because rooms now render the same components.
- An attachment is **first-class data on the entry**: ids and metadata that every wire path carries,
  never a rewrite of `body.text`, and never a shift in a mention span's offsets.
- **Room members, and only room members, can read a room's files.** The chat upload route's access
  model (anyone who can name the `cwd`) does not carry over.
- **Room agents receive the files automatically**, as paths they can open on the first try, on every
  runtime, with no approval prompt and no opt-in step.
- The timeline shows **inline previews when it safely can** and a compact chip otherwise.
- The thread composer gets the same capability as the room composer, because it is the same
  component mounted somewhere else.
- Nothing here constrains DOR-948: no attachment state lives inside `Composer.Input`, so swapping its
  internals for Lexical stays a swap.

## Non-Goals

- **Changing chat.** ADR-0100's fold-into-prompt behavior stays exactly as it is. This spec adds a
  second, different path for rooms; it does not retrofit the first.
- **Agents uploading files.** See Open Question 4 — an agent that wants to share a file writes a path
  in its message, as it does today.
- **Rich text / Lexical** (DOR-948), and the composer shell itself (DOR-946, shipped).
- **Mention addressing.** `apps/server/src/services/rooms/mentions.ts` and the span doctrine are
  untouchable (`.claude/rules/room-conduct.md`).
- **Attachments over the `CommunityAdapter` port.** `CommunityEntrySchema` stays text-only; see
  Blast Radius.
- **Attachments in bridged chats.** `postExternal` does not gain an attachment path in this spec —
  an inbound Telegram photo still arrives as whatever text the adapter writes.
- **Editing or deleting an attachment after it is posted.** A room entry is durable and is not
  edited today; its attachments inherit that.
- **Retention, quotas, and thumbnail generation.** Nothing re-encodes, resizes, or expires a posted
  file, exactly as nothing does for a profile photo.

## Technical Dependencies

No new dependencies. Everything used is already in the tree:

- `multer` (`^2.x`) — already the multipart parser for `routes/uploads.ts` and `routes/profile.ts`.
- `react-dropzone` — already behind `Composer.Root`'s `useDragAndPaste`.
- `better-sqlite3` + Drizzle (`@dorkos/db`) — one new table, one new migration.
- `zod` + `@asteasolutions/zod-to-openapi` (via `.openapi(...)`) — the schema and doc surface.
- Node `crypto` / `fs` — hashing, hardlinks, streams.

## Detailed Design

### The end-to-end flow, once

1. A person picks a file in a room (paperclip → `Composer.Input`'s hidden input; drop onto the card →
   `Composer.Root`'s dropzone; paste → the same root's paste handler). All three land on one
   handler, exactly as chat wires them.
2. Chips appear above the box (`Composer.Attachments`), each with name, size, and status.
3. On **Enter**, the pending files upload as one batch to
   `POST /api/rooms/:id/attachments`. The chips show progress; a failure states its reason on the
   chip and offers a retry; the send does not go out while a chip is in error. This is
   `useFileUpload`'s shipped behavior, re-expressed against the room endpoint.
4. The response carries one `RoomAttachment` per file — id, sanitized name, mime type, size, whether
   it is previewable, and the URL to fetch it from.
5. The composer posts `{ text, attachmentIds }` to `POST /api/rooms/:id/entries` (or
   `POST /api/rooms/:id/threads` for a thread reply). The chips clear; a pending row appears carrying
   the words **and** the attachment names.
6. The server binds those attachment rows to the entry **inside the entry's own transaction** — both
   land or neither does — and publishes the entry on the room stream with its attachments attached.
7. Every reader's timeline draws the entry: verified images as inline thumbnails, everything else as
   a compact chip. Clicking a thumbnail opens the file; clicking a chip downloads it.
8. Before each agent the entry triggers takes its turn, the room's turn runner **projects** every
   attachment in that turn's context window into that agent's own working directory, and the room
   context block names each one by its path relative to that directory. The agent opens it with
   `Read` the way it opens any file in its own tree.

### Storage: room-scoped, under the data directory, behind a store seam

Bytes live at `<dorkHome>/rooms/<roomId>/attachments/<attachmentId>.<ext>`, where `dorkHome` is the
value `resolveDorkHome()` produced at startup — never `os.homedir()` (Hard Rule 3,
`.claude/rules/dork-home.md`), and never `{cwd}/.dork/.temp/uploads/`, which is per-project and
temporary. A room's files are per-install and durable, exactly like a profile photo, so they live
where a profile photo lives.

The access goes through a `RoomAttachmentStore` interface, the same shape `AvatarStore` established
(`apps/server/src/services/identity/avatar-store.ts`):

```ts
/** A stored room attachment, ready to be piped at whoever asked for it. */
export interface StoredRoomAttachment {
  stream: Readable;
  /** What the row says it is. Never re-sniffed on the way out. */
  contentType: string;
  /** A strong ETag, quotes included, derived from the content. */
  etag: string;
  /** The bytes' length, for `Content-Length`. */
  size: number;
}

export interface RoomAttachmentStore {
  /** Write the bytes and answer where the cockpit fetches them from. */
  put(
    roomId: string,
    attachmentId: string,
    extension: string,
    bytes: Buffer
  ): Promise<{ url: string }>;
  /** Open one back, or `null` — including for an id that could never have had one. */
  get(
    roomId: string,
    attachmentId: string,
    extension: string
  ): Promise<StoredRoomAttachment | null>;
  /** The absolute path of one on this machine, or `null` when the bytes are not local. */
  localPath(roomId: string, attachmentId: string, extension: string): Promise<string | null>;
  /** Forget every attachment of one room. Idempotent. */
  deleteRoom(roomId: string): Promise<void>;
}
```

`LocalRoomAttachmentStore` is the only implementation. It answers `put` with a server-relative
`/api/rooms/<roomId>/attachments/<attachmentId>`, and `localPath` with the real file. A future
bucket-backed store answers an absolute `https://…` from `put` and **`null` from `localPath`**, which
is the honest signal that the projection step (below) has to fetch rather than link. `roomId` and
`attachmentId` are treated as opaque and validated by the same `^[A-Za-z0-9][A-Za-z0-9._-]*$`
allowlist `LocalAvatarStore` uses, so neither can be read as a path; a violation throws
`InvalidRoomAttachmentIdError`, which the route turns into a 400.

Files: `apps/server/src/services/rooms/attachments/room-attachment-store.ts`,
`.../local-room-attachment-store.ts`, `.../attachment-paths.ts`, `.../attachment-projection.ts`.

### Data model: a side table, rolled up onto the entry like reactions

`room_entries` gains **no column**. Attachments follow the shape reactions already have: their own
table, joined onto entries in one query per page.

New table in `packages/db/src/schema/rooms.ts`, migration `0057_*` (next after
`0056_rich_vengeance.sql`):

```ts
export const roomAttachments = sqliteTable(
  'room_attachments',
  {
    roomId: text('room_id').notNull(),
    /** ULID. Also the on-disk basename, and the id a post references. */
    id: text('id').notNull(),
    /**
     * The entry this file was posted with, or NULL while it is uploaded and not
     * yet posted. Bound exactly once, inside the entry's own transaction.
     */
    entryId: text('entry_id'),
    /** Who uploaded it. Only they may reference it in a post. */
    authorId: text('author_id').notNull(),
    /** The original filename, sanitized at write time. What a chip renders. */
    name: text('name').notNull(),
    /** The file suffix the bytes are stored under, without a dot. May be ''. */
    extension: text('extension').notNull(),
    /** What it is served as. Sniffed for an image, else the declared type. */
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    /** `'image'` when the bytes were VERIFIED previewable, else NULL. */
    preview: text('preview'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.id] }),
    // The roll-up's whole predicate: every attachment of a page of entries.
    index('idx_room_attachments_entry').on(table.roomId, table.entryId),
    // Partial, like the thread index above it: the sweep asks only for
    // unbound rows, which are a vanishing minority of the table.
    index('idx_room_attachments_unbound')
      .on(table.roomId, table.createdAt)
      .where(sql`entry_id IS NULL`),
    foreignKey({
      columns: [table.roomId, table.entryId],
      foreignColumns: [roomEntries.roomId, roomEntries.id],
    }),
  ]
);
```

The composite foreign key is **nullable on purpose**: SQLite skips a foreign-key check when any
column in the key is `NULL`, which is exactly the "uploaded, not yet posted" state, and enforces it
the moment the row is bound.

Why a side table rather than a JSON column on `room_entries`:

- The upload happens **before** the entry exists, so there is a row to write before there is an entry
  to write it on. A JSON column would need the metadata held client-side across the round trip and
  trusted on the way back, which is the one thing a server must not do with a declared size or type.
- It is exactly the reaction shape, and reactions already proved the read path: one indexed query per
  page, grouped by entry id (`RoomService` lines 2076–2100).
- Sweeping an upload that was never posted is a `WHERE entry_id IS NULL` question, not a scan of
  every entry's JSON.

### Shared schemas (`packages/shared/src/room-schemas.ts`)

```ts
/** How the timeline may render an attachment inline, or `null` for a chip. */
export const RoomAttachmentPreviewSchema = z.enum(['image']).openapi('RoomAttachmentPreview');
export type RoomAttachmentPreview = z.infer<typeof RoomAttachmentPreviewSchema>;

/** The longest original filename a room stores, in UTF-16 code units. */
export const ROOM_ATTACHMENT_NAME_MAX = 255;

/**
 * One file posted with a room entry.
 *
 * Every field is SERVER-DERIVED. `name` is the uploaded filename after the same
 * sanitization `upload-handler.ts` applies, `size` is what actually landed on
 * disk, and `mimeType` is what the bytes were sniffed to be for an image and
 * what the client declared for everything else — which is why nothing is served
 * inline unless `preview` says the bytes themselves were checked.
 */
export const RoomAttachmentSchema = z
  .object({
    id: z.string().min(1).describe('ULID. Stable, unique within the room.'),
    name: z.string().min(1).max(ROOM_ATTACHMENT_NAME_MAX),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative(),
    preview: RoomAttachmentPreviewSchema.nullable().describe(
      'Non-null only when the BYTES were verified as that kind. A declared Content-Type never sets this.'
    ),
    url: z
      .string()
      .min(1)
      .describe(
        'Where to fetch it. Server-relative today; a remote store would answer an absolute https URL and no renderer changes.'
      ),
  })
  .openapi('RoomAttachment');

export type RoomAttachment = z.infer<typeof RoomAttachmentSchema>;
```

`RoomEntrySchema` gains one field, worded from `reactions`, which has the identical lifecycle:

```ts
attachments: z
  .array(RoomAttachmentSchema)
  .optional()
  .describe(
    "The files posted with this entry. Every path that delivers an entry to a reader carries it — the history page, the stream's hydration snapshot, a resume replay, and a live `entry` event. Optional only because the server's internal entry shape exists before the roll-up runs; on the wire it is always present, and absent should be read as empty.",
  ),
```

Both write requests gain the same optional field:

```ts
// PostToRoomRequestSchema and PostThreadReplyRequestSchema
attachmentIds: z
  .array(z.string().min(1))
  .max(ROOM_ATTACHMENT_MAX_PER_ENTRY)
  .optional()
  .describe(
    'Ids from POST /api/rooms/:id/attachments, in the order they should render. Yours, from this room, and not already posted.',
  ),
```

`ROOM_ATTACHMENT_MAX_PER_ENTRY = 50` is the schema's static ceiling and is deliberately **not** the
limit a person feels: it is the maximum `config.uploads.maxFiles` may be set to
(`config-schema.ts:973` — `z.number().int().min(1).max(50)`). The configured value (default `10`) is
enforced in the service, because config is read per request and a Zod literal cannot be.

`text` stays `z.string().min(1)` on both requests. See Open Question 2.

And the upload response:

```ts
export const RoomAttachmentUploadResponseSchema = z
  .object({ attachments: z.array(RoomAttachmentSchema) })
  .openapi('RoomAttachmentUploadResponse');
```

### API surface

Three route changes in `apps/server/src/routes/rooms.ts`, plus the OpenAPI registrations in
`services/core/openapi-registry.ts` and the generated `docs/api/**` pages.

**`POST /api/rooms/:id/attachments`** — multipart, field name `files`.

- Caller must be a **person** (`resolveCaller(res).kind === 'human'`) and a **member** of the room.
  An agent is refused `403 PEOPLE_ONLY` before its bytes are read, in the same shape
  `POST /avatar` refuses one.
- An archived room refuses `409 ROOM_ARCHIVED`; there is nothing to post the file with.
- Multer is built per request from `configManager.get('uploads')`, exactly as `routes/uploads.ts`
  does, so the limits are **chat's limits, from the same source**: `maxFileSize` (default
  `10 * 1024 * 1024` = 10 MB), `maxFiles` (default `10`), `allowedTypes` (default `['*/*']`, i.e.
  every type accepted). `LIMIT_FILE_SIZE` maps to `413` with the same sentence chat produces
  (`File too large (max 10MB)`); a disallowed type maps to `415`.
- Storage is `multer.memoryStorage()`, not disk: the bytes have to be sniffed before anything decides
  the extension, the mime type, or whether the file may ever be served inline. `limits.fileSize` is
  set one byte above the cap for the reason `routes/profile.ts` records — busboy refuses a file that
  _reaches_ the limit.
- Per file the server: sanitizes the name (`path.basename` then `[^a-zA-Z0-9._-] → _`, truncated to
  `ROOM_ATTACHMENT_NAME_MAX`), takes the extension from the sanitized name, sniffs the first twelve
  bytes with the **shared** `sniffAvatarContentType` helper (moved to
  `services/identity/image-sniff.ts` and re-exported so there is exactly one magic-byte reader in the
  tree), sets `preview: 'image'` and `mimeType` from the sniff when it answers, and otherwise sets
  `preview: null` with the client-declared `mimetype`. Then `store.put(...)`, then one row.
- `200 { attachments: RoomAttachment[] }`, in request order.

**`GET /api/rooms/:id/attachments/:attachmentId`** — stream one.

- **A bound attachment is readable by anyone who may read the entry that references it** — the same
  `requireVisibleRoom(roomId, callerId)` check `GET /:id/entries` makes. Any other rule would let a
  person read a message and not the file it is about.
- **An unbound attachment is readable only by the author who uploaded it**, so the composer can draw
  its own chip before the post goes out and nobody else can enumerate a stranger's staging area.
- Anything else — wrong room, no such id, someone else's unbound row — is `404
ATTACHMENT_NOT_FOUND`. Existence is not leaked by a 403.
- Headers, following `GET /api/profile/avatar/:id`: `X-Content-Type-Options: nosniff`, strong
  content-hash `ETag`, `Cache-Control: private, max-age=0, must-revalidate`, `304` on a matching
  `If-None-Match`, and `Content-Length`.
- **`Content-Type` and `Content-Disposition` are decided by `preview`, and by nothing else.**
  `preview === 'image'` → the verified image type and `inline`. Otherwise →
  `application/octet-stream` and `attachment; filename="<sanitized name>"`. A room accepts every type
  by default, so this is the line that keeps an uploaded `.html` from being rendered as a document in
  another member's browser under the cockpit's own origin.

**`POST /api/rooms/:id/entries` and `POST /api/rooms/:id/threads`** — accept `attachmentIds`.

The service (`RoomService.post` → `writePost`) resolves them **before** writing anything:

| Condition                                                  | Refusal                         |
| ---------------------------------------------------------- | ------------------------------- |
| More ids than `config.uploads.maxFiles`                    | `400 TOO_MANY_ATTACHMENTS`      |
| Duplicate ids in one request                               | `400 TOO_MANY_ATTACHMENTS`      |
| Id not in this room, or unbound and owned by somebody else | `404 ATTACHMENT_NOT_FOUND`      |
| Id already bound to an entry                               | `409 ATTACHMENT_ALREADY_POSTED` |

Three new `RoomErrorCode` values — `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_ALREADY_POSTED`,
`TOO_MANY_ATTACHMENTS` — plus the existing `PEOPLE_ONLY`, reused for the agent refusal on upload.

The bind rides `writePost`'s existing `within(tx)` hook — the same seam `postExternal` uses to join
an author atomically with their first message — so **an entry and its attachment bindings land in one
transaction or neither lands**. A log holding an entry that claims files nothing points at is a
record that contradicts itself.

`publishEntry` then attaches the just-bound refs to the `entry` frame (the counterpart of
`reactions: []` at line 2131), and the read paths attach them the way reactions are attached: one
`WHERE room_id = ? AND entry_id IN (…)` per page in `listEntries` and in the hydration snapshot.

**Transport** (`packages/shared/src/transport-rooms.ts`): one new method, plus the request type
change that `postToRoom` / `replyInThread` inherit from the schema.

```ts
/**
 * Upload files into a room, before the message that carries them.
 *
 * Separate from {@link postToRoom} rather than a field on it for the reason the
 * multipart body forces and the access model confirms: bytes and JSON are
 * different requests, and the attachment exists — refusable, retryable, its own
 * progress — before there is an entry to hang it on.
 */
uploadRoomAttachments(
  id: string,
  files: UploadFile[],
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<RoomAttachment[]>;
```

`HttpTransport` implements it by generalizing `uploadFilesOverHttp` to take a URL instead of building
`/uploads?cwd=…` itself — the XHR progress channel, the silence watchdog, and the cancel semantics
are reused verbatim, not re-derived. `embedded-mode-stubs.ts` gains the one-line stub every other
room method already has (`Rooms are not supported in embedded mode`), which is the whole of the
Obsidian/DirectTransport work.

### Capability wiring: rooms compose attach

`RoomComposer` (`apps/client/src/layers/widgets/room-view/ui/RoomComposer.tsx`) already renders
`Composer.Root` and `Composer.Input`. It gains:

```tsx
const attachments = useRoomAttachments(room.id);

<Composer.Root onFilesDropped={attachments.addFiles}>
  …
  {attachments.pendingFiles.length > 0 && (
    <Composer.Attachments
      files={attachments.pendingFiles}
      onRemove={attachments.removeFile}
      onRetry={attachments.retryFile}
      onCancel={attachments.cancelUpload}
    />
  )}
  <Composer.Input … onAttach={attachments.addFiles} />
</Composer.Root>
```

**That composition IS the capability declaration** — there is no flag to set, per the slice's own
doctrine. The barrel's capability matrix in `features/composer/index.ts` therefore changes as part of
this spec's scope: the Room column reads **`yes`** for _Attach (chip bar, drag, paste)_, and the
"reserved" note below the table drops its attachment half and keeps only the slash-command half.
Leaving it at "reserved" once rooms compose attach would be precisely the parallel declaration that
doctrine forbids.

Gating: `canSubmit` becomes `!room.archived && !attachments.hasFailedUpload`, with
`canSubmitReason` explaining a failed chip in one line — the same refusal chat makes, expressed
through props the composer already has. `handleSubmit` becomes async: it takes the draft, uploads any
pending files (`await attachments.uploadAndGetIds()`), and posts. Nothing about this reaches
`Composer.Input`, so DOR-948's swap of its internals stays unaffected.

`useRoomAttachments` lives at `widgets/room-view/model/use-room-attachments.ts` — a widget, because
it needs `PendingFile` from `features/composer`, and an entity may not import a feature. It is
`useFileUpload` re-expressed: same `PendingFile` state machine, same batch upload, same
`hasFailedUpload` refusal, same cancel-aborts-the-request behavior, differing only in the endpoint it
calls and in returning **ids** rather than paths. Keyed by room id so a thread composer and its room
composer, which are two mounts of `RoomComposer`, do not share a chip bar.

### Thread composer parity

None of the above is conditioned on `threadRootId`. The thread panel mounts the same `RoomComposer`,
so it gets attach for free; the only difference is that its submit calls `replyInThread` with the
same `attachmentIds`. `PostThreadReplyRequestSchema` therefore takes the identical field, and
`POST /:id/threads` runs the identical resolution — thread replies go through the same `writePost`.

### Timeline rendering

A new module beside the already-split `RoomEntryBody`, per the design record's instruction that
attachment rendering must not grow `RoomEntryRow` back:
`apps/client/src/layers/widgets/room-view/ui/RoomEntryAttachments.tsx`.

- `preview === 'image'` → an inline thumbnail (`<img>` at `max-h-64 max-w-full rounded-md border`,
  `loading="lazy"`, `alt` = the attachment name) inside a link that opens the file.
- everything else → a compact chip: file icon, name, and human-readable size, as a download link.
- Several attachments wrap in a `flex flex-wrap gap-2` row under the body.
- Rendered from `entry.attachments ?? []`, so an entry that predates the field renders nothing.
- The block sits inside the entry's content column and is included in the row's described content,
  so a screen reader hears "2 files: screenshot.png, notes.pdf" rather than nothing.

`RoomPendingRow` gains the same chips, name-only and inert (no thumbnail, no link — the file has an
id but the row exists precisely because the entry does not yet). `PendingPost` in
`entities/room/model/pending-posts.ts` gains `attachmentNames: string[]`, defaulted `[]`, and
`usePostToRoom` / `useReplyInThread` pass it through from the mutation input. Without this a person
who attaches three files watches them vanish from the chip bar and not reappear until the echo lands.

### Agent delivery: projection into the agent's own working directory

The locked decision is that paths reach room agents automatically, with no opt-in step. That rules
out handing an agent an absolute path under `<dorkHome>/rooms/…`: a room turn runs with
`cwd: request.agentPath` (`room-turn-runner.ts:202,250`), the attachment directory is outside it, and
a read outside the working directory is exactly what a runtime asks permission for — which would park
the turn on `awaiting_approval` and make "automatic" false. Widening the `AgentRuntime` port with a
per-turn filesystem grant would fix it for claude-code's `settings.permissions` and then need a
different answer for codex and opencode.

So the file is brought to the agent instead, which is what chat's shipped shape already does — files
live inside the working directory, and the agent is told a relative path (ADR-0100).

Before a triggered turn starts, `room-turn-runner` projects every attachment that turn's context
mentions into that agent's tree:

```
{agentPath}/.dork/.temp/room-attachments/{entryId}/{attachmentId}-{name}
```

- **Hardlink first, copy on failure.** `<dorkHome>` and the default agents directory
  (`~/.dork/agents`) are normally the same filesystem, so a link costs an inode and no bytes;
  `EXDEV` or `EPERM` falls back to a copy. When `store.localPath()` answers `null` — a future remote
  store — the bytes are fetched and written.
- **Idempotent.** A projection that already exists is left alone, so re-triggering an agent in a busy
  room costs one `stat` per file.
- **Scoped to what the model is actually shown.** The projector walks the same capped
  `pending` window `room-context.ts` builds (`PENDING_MAX_ENTRIES = 30`), so every path the agent
  reads about is one it can open. Nothing else is projected.
- **Swept on the way in.** Each projection run removes entry directories under that agent's
  `room-attachments/` older than 24 hours, so the tree does not grow without bound and no scheduler is
  introduced to make that true.

`RoomContextEntry` (`packages/shared/src/additional-context.ts`) gains:

```ts
/**
 * The files posted with this entry, as paths relative to the agent's own
 * working directory. Empty for an entry with none.
 *
 * Relative, so this module stays pure: the path is a function of the entry id
 * and the stored filename, identical for every agent, and never of a cwd this
 * builder must not know.
 */
attachments: {
  name: string;
  path: string;
}
[];
```

`room-context.ts` fills it from the roll-up through the one shared helper both it and the projector
call (`attachment-paths.ts`), so the path the model is told and the path on disk cannot drift.
`room-context-block.ts`'s `entryLine` renders it as one bracketed suffix, the same shape `[topic: …]`
and `[mentions you]` already take:

```
[14:02] Ana (person, @ana): here is the crash …  [attached: .dork/.temp/room-attachments/01J…/01J…-crash.log]
```

The name and path are both server-generated after sanitization, and both go through `label()` like
every other value DorkOS writes into a line, so a filename cannot forge a chat line.

### Blast radius

- **Wire shape.** `RoomEntry` gains an optional array; every reader that ignores unknown fields is
  unaffected. SSE `entry` frames, the hydration snapshot, the history page, and resume replay all
  carry it (and all are covered by the roll-up, not by four separate code paths).
- **`CommunityAdapter`.** `CommunityEntrySchema` stays text-only and `local-projection.ts:92`
  continues to map `entry.body.text`. Attachments are dropped at that port, which is correct for now
  — nothing user-facing routes through it (`AGENTS.md`), and widening the port means widening
  `communityConformance` for every future backend. Recorded as a follow-up, and stated in the
  projection module's TSDoc so it is a decision and not an omission.
- **DB.** One new table, one migration. `room_entries` is untouched, so no backfill and no risk to
  the hot write path.
- **Config.** None. The limits are the existing `uploads` section, read at request time. No new
  config field, so no `safe-defaults` verdict and no `conf` migration.
- **OpenAPI.** Two new paths and two changed request bodies; `docs/api/**` regenerates via
  `scripts/export-openapi.ts`, and the freshness check in CI must be run before the PR opens.
- **E2E.** `apps/e2e/tests/rooms/` gains one spec; the fifteen existing ones run unmodified.
- **Chat.** Untouched. `useFileUpload`, `ChatPanel.fileTransformContent`, `routes/uploads.ts` and
  `parse-file-prefix.ts` are all unchanged.

## User Experience

**Attaching.** In any room or thread, click the paperclip, drag a file onto the composer card, or
paste one. A chip appears above the box with the filename and size. Remove it with the ×.

**Sending.** Press Enter. The chips show an upload bar; while a file is uploading the × cancels the
upload rather than removing the row (the shipped chat behavior, DOR-494). If one fails, the chip says
so in words, offers **Retry**, and the message does not go out — a line above the box explains why
Enter did nothing. When the upload finishes the message posts and your words appear in the
conversation immediately, with the filenames beside them, until the room echoes the real entry back.

**Reading.** An image shows as a picture in the conversation; click it to open it full size.
Everything else shows as a chip with the file's name and size; click it to download. Files are
readable by the people and agents in that room and by nobody else.

**Agents.** An agent you address in a room gets the files with the message. It does not ask
permission and there is nothing to approve — it simply has them.

**Where it stops.** You cannot post a file with no words: type something, even one word. An agent
cannot attach a file to its own message. An archived room refuses attachments as it refuses messages.

## Testing Strategy

**Unit — server**

- `local-room-attachment-store.test.ts`: round-trip put/get; the strong ETag matches the bytes; an id
  containing `..`, `/`, or a leading dot is refused by `InvalidRoomAttachmentIdError` (mutation:
  loosening `SAFE_ID` to allow a dot-leading id must turn this red); `localPath` answers a real,
  readable path; `deleteRoom` is idempotent.
- `room-attachment-store.test.ts`: the seam claim, asserted rather than promised — a fake store
  answering `https://cdn.example/x.bin` from `put` and `null` from `localPath` makes the route serve
  that URL unchanged and makes the projector fetch instead of link. This is the exact shape
  `profile-avatar.test.ts` uses for `AvatarStore`, and it is what makes the "sync-ready" claim
  falsifiable.
- `rooms-attachments.test.ts` (route): an agent caller is refused `PEOPLE_ONLY` **before** multer
  runs (assert no file was written); a non-member is refused; over-size maps to 413 with the
  configured megabyte figure; a `.png` full of GIF bytes stores with `preview: null` and is served
  `application/octet-stream` + `attachment` (mutation: trusting `file.mimetype` for `preview` turns
  this red); a real PNG is served `image/png` + `inline`; `If-None-Match` gets a 304; a bound
  attachment is readable by another member and an unbound one is not.
- `room-service-attachments.test.ts`: binding is atomic — a `within(tx)` failure injected after the
  entry insert leaves **no** entry and **no** bound row; a second post naming the same id is refused
  `ATTACHMENT_ALREADY_POSTED`; an id from another room is `ATTACHMENT_NOT_FOUND`; more ids than
  `config.uploads.maxFiles` is `TOO_MANY_ATTACHMENTS` (mutation: reading the static `50` instead of
  the configured value must turn this red).
- `room-context.test.ts`: an entry with attachments produces the relative paths; `entryLine` renders
  the bracketed suffix; a filename carrying a newline or an angle bracket cannot break the line
  (already impossible after sanitization — the test pins that it stays impossible).
- `attachment-projection.test.ts`: a projection is a hardlink when possible and a copy when `link`
  throws `EXDEV`; a second run is a no-op; a 25-hour-old entry directory is swept and a 23-hour-old
  one is not; a `localPath` of `null` takes the fetch branch.
- Roll-up parity: `listEntries`, the hydration snapshot and the live `entry` frame all carry
  `attachments` for the same entry (one test, three paths — the failure mode is a path somebody
  forgot).

**Unit — client**

- `use-room-attachments.test.ts`: add/remove/retry/cancel mirror `use-file-upload`'s covered
  behaviors; `uploadAndGetIds` **throws** when any chip is in error rather than silently dropping it
  (the DOR-480 lesson, re-pinned for rooms); two rooms keep separate chip bars.
- `RoomComposer.test.tsx`: the composer mounts the dropzone (`role="presentation"` and a file input
  appear) — the positive counterpart of the DOR-946 assertion that it did **not**; Enter with a
  failed chip does not post; the attach handler is wired to both `onAttach` and `onFilesDropped`.
- `RoomEntryAttachments.test.tsx`: `preview: 'image'` renders an `<img>` with the name as `alt`;
  `preview: null` renders a download chip and **no** `<img>` (mutation: rendering a thumbnail from
  `mimeType.startsWith('image/')` instead of from `preview` turns this red — that is the whole
  safety property); an entry with no `attachments` renders nothing.
- `RoomPendingRow.test.tsx`: pending attachment names render, inert.
- **DOM-parity harness (the DOR-946/956 technique):** the room composer with **no** files pending
  must diff **empty** against the committed `RoomComposer` baseline. Attach is additive; a person who
  never touches a file must see the composer they had yesterday. This is the discriminating check —
  it fails on any stray wrapper, class, or spacing the wiring introduces.

**E2E** — `apps/e2e/tests/rooms/room-attachments.spec.ts`, against the mock runtime: set an input
file in a room composer, assert the chip, send, assert the entry row shows an image thumbnail and a
non-image chip, and assert a second browser context in the same room sees both. Then the refusal:
a member-less context gets a 404 fetching the attachment URL directly.

**Not tested here:** anything requiring a real model turn. The projection is asserted at the unit
level over a real temp filesystem, which is where its failure modes actually live.

## Performance Considerations

- **Reads:** one extra indexed query per page of entries, grouped in memory — the reaction roll-up's
  cost, measured at the same shape and on the same index pattern. `listEntries` caps at
  `ROOM_ENTRY_PAGE_SIZE_MAX = 200`.
- **Uploads:** files are held in memory to be sniffed, bounded by `maxFileSize * maxFiles` = 100 MB
  at the default config and by 50 × the configured size at the schema's ceiling. That is the same
  bound `POST /api/uploads` already accepts, minus the disk write, and it is why `limits.fileSize`
  refuses over-size _while the request is being read_.
- **Projection:** a hardlink per file per triggered agent, skipped when it already exists. The
  degenerate case — a remote store, so a fetch — is bounded by the same 30-entry window.
- **Serving:** streamed, never buffered, with a content ETag so a re-render of the timeline costs a 304. The ETag is computed from the file on the way out, exactly as `LocalAvatarStore` does, so it
  cannot drift from the bytes; that is one extra local read per cache miss.
- **Room turns:** nothing here runs on the addressing, cascade-guard, or budget path, so the cost of
  _listening_ to a room is unchanged (etiquette E7).

## Security Considerations

- **The serving rule is the security boundary.** A room accepts every mime type by default
  (`allowedTypes: ['*/*']`), so a member can upload HTML, SVG, or a script. Nothing is served inline
  unless its bytes were magic-verified as PNG, JPEG, or WebP; everything else is
  `application/octet-stream` with `Content-Disposition: attachment` and `X-Content-Type-Options:
nosniff`. SVG is deliberately not previewable — it is a script vector, and `routes/files.ts` needs
  a bespoke CSP sandbox to serve one safely.
- **Only bytes decide what a file is.** The filename and the declared `Content-Type` are both written
  by whoever is uploading. This reuses `sniffAvatarContentType`, including its hard-won `Buffer.equals`
  discipline — the earlier ASCII-decoded RIFF check accepted high-bit HTML as a WebP.
- **Ids are opaque and path traversal is refused by construction**, not escaped: the `SAFE_ID`
  allowlist plus a resolved-path containment check, the same double guard `LocalAvatarStore` and
  `routes/uploads.ts` both make.
- **Access is membership-scoped.** Chat's route lets anyone who can name a `cwd` read what is in it;
  this one asks the room. Unbound attachments are visible only to their uploader, so a staging area
  cannot be enumerated.
- **An attachment name is untrusted text.** It is sanitized at write time to
  `[A-Za-z0-9._-]`, stored sanitized, rendered through React (which escapes) in the client, and
  through `label()` in the agent context block, so it cannot forge a chat line inside the fence
  (`.claude/rules/room-conduct.md`).
- **A file an agent reads is untrusted input**, the same as another member's words. The path arrives
  inside the room context fence with its per-turn nonce; the model is told it is a file somebody in
  the room attached, not an instruction.
- **The projection writes into an agent's own directory.** It writes only under
  `.dork/.temp/room-attachments/`, only for rooms that agent is a member of, and only files that
  agent's turn is about to be told about.

## Documentation

- **User docs:** `docs/` gains attachments to the rooms guide — one short section, `writing-for-humans`
  register: what you can attach, that only the room can read it, and that agents get it automatically.
- **Changelog:** one fragment in `changelog/unreleased/`, user-facing.
- **API docs:** regenerate `docs/api/**` + `docs/api/openapi.json` from the registry
  (`scripts/export-openapi.ts`) — two new paths, two changed bodies.
- **TSDoc:** module docs on the new store, the projector and the client hook; the capability-matrix
  table in `features/composer/index.ts` updated (Room → Attach = `yes`).
- **Dev playground:** a `RoomEntryAttachments` showcase (image + non-image + several), per
  `maintaining-dev-playground`.
- **`contributing/`:** `project-structure.md` gains the `services/rooms/attachments/` entry.

## Implementation Phases

Each phase is separately reviewable and independently green; the feature is not visible to anyone
until phase 4.

1. **Storage and schema.** `RoomAttachmentStore` + `LocalRoomAttachmentStore` + `attachment-paths.ts`;
   the `room_attachments` table and migration `0057`; the shared Zod schemas and the `RoomEntry`
   field. Proof: store tests including the fake-store seam assertion; migration applies and the entry
   shape round-trips.
2. **Server routes and binding.** `POST /:id/attachments`, `GET /:id/attachments/:attachmentId`,
   `attachmentIds` on both write requests, the atomic bind through `within(tx)`, the roll-up on all
   three read paths, the four error codes, OpenAPI + generated docs. Proof: route and service tests,
   including the atomicity and the inline/download split.
3. **Agent delivery.** `RoomContextEntry.attachments`, `room-context.ts` fill,
   `room-context-block.ts` line, and the projector wired into `room-turn-runner`. Proof: projection
   tests over a real temp filesystem, context-block rendering tests.
4. **Client.** `uploadRoomAttachments` on the transport + the embedded stub, `useRoomAttachments`,
   `RoomComposer` wiring, the capability-matrix update, `RoomEntryAttachments`, `RoomPendingRow`
   names, playground, docs, changelog. Proof: client unit tests, the empty DOM-parity diff for a
   composer with no files, and the e2e spec.

## Open Questions

1. ~~**Do room agents receive attachment paths automatically, or is there an opt-in?**~~
   **(RESOLVED — locked at the 2026-08-07 spec review, Dorian.)** **Answer:** automatically, with the
   entry, no opt-in step. **Rationale:** carried into the design as the reason the delivery mechanism
   is a projection into the agent's own working directory rather than an absolute path — an approval
   prompt on a read outside the cwd _is_ an opt-in step, so absolute paths would have made the locked
   answer false in practice.

2. ~~**Can a person post an attachment with no words?**~~ **(RESOLVED — derived from the shipped chat
   behavior.)** **Answer:** no. `text` stays `z.string().min(1)` on both write requests, and the
   composer refuses an empty submit exactly as it does today. **Rationale:** chat already refuses it —
   `use-session-submit.ts:466` returns early on `!input.trim()` regardless of pending files — and the
   locked sequencing is that rooms reach parity with chat, not past it. Changing it would change both
   surfaces, which is a different piece of work. Worth revisiting once, deliberately, for both.

3. ~~**What are the size, count, and type limits?**~~ **(RESOLVED — locked at the 2026-08-07 spec
   review: "chat's existing limits apply.")** **Answer:** the `uploads` section of user config, read
   per request through `configManager.get('uploads')` exactly as `routes/uploads.ts` reads it:
   `maxFileSize` default `10 * 1024 * 1024` (10 MB), `maxFiles` default `10`, `allowedTypes` default
   `['*/*']`. **Rationale:** one source, one place to change it, and no new config field to classify
   under `safe-defaults`. The `['*/*']` default is why the _serving_ rule, not the _accepting_ rule,
   carries the safety.

4. ~~**May an agent attach a file to a room post?**~~ **(RESOLVED — derived from the existing
   person/agent split.)** **Answer:** no. `POST /:id/attachments` refuses a caller the server resolves
   as an agent with `403 PEOPLE_ONLY`, before its bytes are read. **Rationale:** it is the same line
   reactions draw (`PEOPLE_ONLY`, etiquette E16b) and profile photos draw (`OPERATOR_ONLY`), for the
   same reason — an agent that wants to share a file writes the path in its message, which already
   works and which every other agent in the room can already read. Opening agent uploads means
   answering quota, provenance, and "which of the agent's files may leave its tree", none of which
   this work needs.

5. ~~**Where do the bytes live, given a room has no cwd?**~~ **(RESOLVED — derived from ADR
   260806-222546 and the shipped DOR-976 implementation.)** **Answer:**
   `<dorkHome>/rooms/<roomId>/attachments/<id>.<ext>`, via `resolveDorkHome()`, behind a
   `RoomAttachmentStore` seam. **Rationale:** the profile-photo decision established the pattern for a
   per-install, durable file — the store returns the URL, nothing above it builds a path — and it is
   the same reason `{cwd}/.dork/.temp/uploads` is wrong here: per-project and temporary, for a thing
   that is neither.

6. ~~**Does the entry carry the attachment refs, or their ids?**~~ **(RESOLVED — derived from the
   reaction roll-up.)** **Answer:** the request carries ids; the entry on the wire carries whole refs,
   rolled up from `room_attachments` on every read path, as `reactions` are. **Rationale:** the server
   must never take a size, a name, or a type from the client on the way back in; and the reader must
   never need a second round trip to draw a chip. The two requirements point at ids in and refs out.

No open questions remain for spec review.

## Related ADRs

- **Draft, extracted from this spec:** `260807-233815` — room attachments are room-scoped,
  upload-then-reference, stored under `dorkHome` behind a store seam.
- **Draft, extracted from this spec:** `260807-233816` — room attachments reach agents as files
  projected into the agent's own working directory, never as an absolute path.
- **ADR-0100** (file path injection for agent uploads) — chat's fold-into-prompt path. Unchanged, and
  the source of the negative this spec is built around (_"if the agent's cwd differs from the upload
  cwd, relative paths may not resolve correctly"_).
- **ADR 260806-222546** (`imageUrl` is the fourth render-cache field, stored locally behind a
  sync-ready seam) — the storage and store-seam pattern this follows.
- **ADR 260807-173219** (one compound composer family) — why composition is the capability
  declaration, and why this spec edits the matrix rather than adding a flag.
- **ADR-0273** (structured context injection) — why attachments ride `additionalContext` and never
  the prompt.
- **ADR 260728-022013** (a thread is a relation between entries) — why the thread composer needs no
  separate treatment.
- **ADR 260726-170127** (cascade guard) — untouched; attachments change no provenance.

## References

- DOR-947 · project "Rooms, Channels & Threads" · umbrella DOR-951
- `specs/room-attachments/01-ideation.md`, `specs/room-attachments/design-decisions.md`
- `specs/composer-parity/02-specification.md`, `04-implementation.md` (DOR-946, shipped @ `ec423e8e9`)
- Design session: `.dork/visual-companion/81863-1786054606/` (2026-08-06)
- `.claude/rules/room-conduct.md`, `.claude/rules/dork-home.md`, `.claude/rules/fsd-layers.md`,
  `.claude/rules/api.md`
- Prior art in-tree: `apps/server/src/services/identity/{avatar-store,local-avatar-store}.ts`,
  `apps/server/src/routes/profile.ts`,
  `apps/server/src/services/rooms/reactions/reaction-store.ts`,
  `apps/client/src/layers/features/chat/model/use-file-upload.ts`
