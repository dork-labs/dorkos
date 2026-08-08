# Room attachments — task breakdown

**Spec:** [02-specification.md](./02-specification.md) · **Work item:** DOR-947 · **Generated:** 2026-08-07 · **Mode:** full

22 tasks across 4 phases. Dependencies are hard ordering; `parallelWith` marks tasks that may run concurrently.

## Phase 1 — Storage and schema

### Task 1.1: Add the RoomAttachment shared schemas and the entry/request fields

- **Size:** small · **Priority:** high
- **Depends on:** — · **Parallel with:** 1.2, 1.3

All edits in `packages/shared/src/room-schemas.ts`. VERIFIED against the tree: `RoomEntrySchema` is at line 613, its `reactions` field at 647-654, `PostToRoomRequestSchema` at 712, `PostThreadReplyRequestSchema` at 787.

Add, above `RoomEntrySchema` and beside `RoomEntryReactionSchema` (line 542) so the two roll-up types sit together:

```ts
/** How the timeline may render an attachment inline, or `null` for a chip. */
export const RoomAttachmentPreviewSchema = z.enum(['image']).openapi('RoomAttachmentPreview');
export type RoomAttachmentPreview = z.infer<typeof RoomAttachmentPreviewSchema>;

/** The longest original filename a room stores, in UTF-16 code units. */
export const ROOM_ATTACHMENT_NAME_MAX = 255;

/**
 * The most attachment ids one post may name.
 *
 * The SCHEMA's static ceiling, deliberately not the limit a person feels: it is
 * the maximum `config.uploads.maxFiles` may be set to
 * (`packages/shared/src/config-schema.ts` — `z.number().int().min(1).max(50).default(10)`).
 * The CONFIGURED value is enforced in the service, because config is read per
 * request and a Zod literal cannot be.
 */
export const ROOM_ATTACHMENT_MAX_PER_ENTRY = 50;

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

/** What `POST /api/rooms/:id/attachments` answers with, in request order. */
export const RoomAttachmentUploadResponseSchema = z
  .object({ attachments: z.array(RoomAttachmentSchema) })
  .openapi('RoomAttachmentUploadResponse');

export type RoomAttachmentUploadResponse = z.infer<typeof RoomAttachmentUploadResponseSchema>;
```

Then add to `RoomEntrySchema`, directly after the `reactions` field (which ends at line 654) — worded from `reactions`, which has the identical lifecycle:

```ts
    attachments: z
      .array(RoomAttachmentSchema)
      .optional()
      .describe(
        "The files posted with this entry. Every path that delivers an entry to a reader carries it — the history page, the stream's hydration snapshot, a resume replay, and a live `entry` event. Optional only because the server's internal entry shape exists before the roll-up runs; on the wire it is always present, and absent should be read as empty."
      ),
```

And the identical optional field on BOTH write requests (`PostToRoomRequestSchema` after its `sessionId` field, `PostThreadReplyRequestSchema` after its `sessionId` field):

```ts
    attachmentIds: z
      .array(z.string().min(1))
      .max(ROOM_ATTACHMENT_MAX_PER_ENTRY)
      .optional()
      .describe(
        'Ids from POST /api/rooms/:id/attachments, in the order they should render. Yours, from this room, and not already posted.'
      ),
```

`text` STAYS `z.string().min(1).max(100_000)` on both — a file with no words is refused, which is what chat already does (`use-session-submit.ts` returns early on `!input.trim()` regardless of pending files). Do not relax it.

Every new export needs TSDoc — `eslint-plugin-jsdoc` is error-level.

Acceptance: `pnpm --filter @dorkos/shared typecheck` and `pnpm --filter @dorkos/shared lint` green; `pnpm --filter @dorkos/shared build` succeeds (downstream packages resolve the dist, and a stale dist is the repo's classic false-red — rebuild before believing a type error in server or client). `pnpm vitest run packages/shared` green.

### Task 1.2: Add the room_attachments table, migration 0057, and its migration-test coverage

- **Size:** medium · **Priority:** high
- **Depends on:** — · **Parallel with:** 1.1, 1.3

Add the table to `packages/db/src/schema/rooms.ts`. VERIFIED: that file already exports `authors` (43), `handleTombstones` (182), `rooms` (219), `roomMembers` (278), `roomEntries` (331), `roomEntryReactions` (453), `roomSessions` (492), and already imports `sql, sqliteTable, text, integer, index, uniqueIndex, primaryKey, foreignKey` at lines 1-10 — no import changes needed. `packages/db/drizzle.config.ts` already lists `./src/schema/rooms.ts`, so no config change either.

Place the new table directly after `roomEntryReactions` (which ends at line 482), because it is the same shape and the file reads as entries-then-side-tables:

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
    index('idx_room_attachments_entry').on(table.roomId, table.entryId),
    index('idx_room_attachments_unbound')
      .on(table.roomId, table.createdAt)
      .where(sql`"entry_id" IS NULL`),
    foreignKey({
      columns: [table.roomId, table.entryId],
      foreignColumns: [roomEntries.roomId, roomEntries.id],
      name: 'room_attachments_entry_fk',
    }).onDelete('cascade'),
  ]
);
```

Three things verified against the tree that the spec's draft did not spell out and that you must keep:

1. **Name the foreign key.** `roomEntryReactions` names its own (`name: 'room_entry_reactions_entry_fk'`, rooms.ts:481). Follow it — an unnamed composite FK produces an unstable generated name in the migration SQL.
2. **`.onDelete('cascade')`, for the same reason reactions carry it** (rooms.ts:433-438): nothing deletes a room entry today, but the design says a message's files die with it, and the honest place for that is the constraint rather than a cleanup step beside a future `deleteEntry`.
3. **The partial-index predicate is quoted the way the existing one is.** `idx_room_entries_thread_root` uses ``sql`"thread_root_entry_id" IS NOT NULL` `` (rooms.ts:413) — double-quoted column name. Match it or the generated SQL differs from the file's convention.

The composite FK is nullable ON PURPOSE: SQLite skips a foreign-key check when any column of the key is NULL, which is exactly the "uploaded, not yet posted" state, and enforces it the moment the row is bound. `createDb` sets `sqlite.pragma('foreign_keys = ON')` (`packages/db/src/index.ts:31`), so this is enforced, not decorative — which is the whole reason task 2.1 exists.

The parent key already exists: `room_entries_room_id_entry_id_unique` on `(room_id, id)` (rooms.ts:407), so this costs no new index on the parent side.

Generate the migration: `pnpm --filter @dorkos/db run db:generate` (runs `drizzle-kit generate --config drizzle.config.ts`). The next file is `0057_*.sql` — VERIFIED, `packages/db/drizzle/0056_rich_vengeance.sql` is the last one and `drizzle/meta/_journal.json`'s final entry is `{"idx": 56, "tag": "0056_rich_vengeance"}`. Commit BOTH the `.sql` and the regenerated `meta/` snapshot. Never hand-write the SQL.

**KNOWN GOTCHA, not in the spec: `packages/db/src/__tests__/migrations.test.ts` will fail without an edit.** Its test `'creates all expected tables'` (line 71) asserts against a HARDCODED array of every table name in `sqlite_master` (lines 82-169). Add `'room_attachments'` to it in alphabetical position (between `'room_bridges'` and `'room_entries'`). Also add a partial-index assertion modelled verbatim on the existing `'gives room_entries its thread relation, behind a partial index'` test at line 346, which re-queries `sqlite_master` for the index name and asserts its `.sql` contains the predicate — assert `idx_room_attachments_unbound`'s SQL contains `WHERE "entry_id" IS NULL`.

Acceptance: `pnpm vitest run packages/db/src/__tests__/migrations.test.ts` green (this is the red-before-green proof — it MUST be red before the table-list edit and green after); `pnpm --filter @dorkos/db run db:check` green (`scripts/assert-migrations-current.sh` re-runs the generator and fails if schema and committed migrations still disagree); `pnpm --filter @dorkos/db typecheck` green.

### Task 1.3: Extract the magic-byte reader into services/identity/image-sniff.ts

- **Size:** small · **Priority:** high
- **Depends on:** — · **Parallel with:** 1.1, 1.2

There must be exactly one magic-byte reader in the tree. Today it lives inside the avatar store; rooms need it too, and a second copy is how the RIFF bug comes back.

**DRIFT NOTE:** the spec says `sniffAvatarContentType` is "moved to `services/identity/image-sniff.ts` and re-exported". VERIFIED: it currently lives in `apps/server/src/services/identity/avatar-store.ts` at line 138, together with `AVATAR_CONTENT_TYPES` (24), `AvatarContentType` (27) and the four magic constants `PNG_MAGIC` / `JPEG_MAGIC` / `RIFF_MAGIC` / `WEBP_MAGIC` / `WEBP_FORM_OFFSET` (107-113). There is no `image-sniff.ts` yet.

Create `apps/server/src/services/identity/image-sniff.ts` and MOVE into it, unchanged:

- `AVATAR_CONTENT_TYPES` and `AvatarContentType` — but RENAME them `PREVIEWABLE_IMAGE_TYPES` / `PreviewableImageType`, because rooms are not avatars and the name should not say otherwise. Keep the value identical: `['image/png', 'image/jpeg', 'image/webp'] as const`.
- the five magic constants, verbatim.
- the function, renamed `sniffImageContentType(bytes: Buffer): PreviewableImageType | null`, with its body byte-for-byte:

```ts
export function sniffImageContentType(bytes: Buffer): PreviewableImageType | null {
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png';
  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image/jpeg';
  if (
    bytes.subarray(0, RIFF_MAGIC.length).equals(RIFF_MAGIC) &&
    bytes.subarray(WEBP_FORM_OFFSET, WEBP_FORM_OFFSET + WEBP_MAGIC.length).equals(WEBP_MAGIC)
  ) {
    return 'image/webp';
  }
  return null;
}
```

Carry its existing TSDoc across VERBATIM — it records the hard-won `Buffer.equals` discipline (an earlier ASCII-decoded RIFF check accepted high-bit HTML as a WebP) and that paragraph is the reason the function is shaped this way. If a diff of the function body is anything other than 0 changed lines, stop.

Then update, and nothing else:

1. `avatar-store.ts` — delete the moved symbols; re-export the two names the existing callers use so no caller outside identity changes shape:
   ```ts
   export {
     PREVIEWABLE_IMAGE_TYPES as AVATAR_CONTENT_TYPES,
     sniffImageContentType as sniffAvatarContentType,
     type PreviewableImageType as AvatarContentType,
   } from './image-sniff.js';
   ```
   Keep `MAX_AVATAR_BYTES`, `StoredAvatar`, `AvatarStore`, `InvalidAvatarIdError` where they are.
2. `apps/server/src/services/identity/local-avatar-store.ts` — its import block at lines 18-24 pulls `AVATAR_CONTENT_TYPES` and `AvatarContentType` from `./avatar-store.js`; the re-export keeps that resolving. Verify by typecheck, change nothing.
3. `apps/server/src/routes/profile.ts` lines 24-29 import `sniffAvatarContentType` from `'../services/identity/avatar-store.js'` — unchanged for the same reason.
4. `apps/server/src/services/identity/__tests__/avatar-store.test.ts` imports `sniffAvatarContentType` from `'../avatar-store.js'` (line 7) and is a pure unit test of the sniffer with no filesystem. MOVE that file to `apps/server/src/services/identity/__tests__/image-sniff.test.ts`, repoint its import to `'../image-sniff.js'` and its identifier to `sniffImageContentType`. Its assertions — PNG/JPEG/WebP accepted, SVG/GIF/high-bit-RIFF/truncated-buffer refused — must NOT change. A moved test that needs a real assertion edited is proof of a behavior change; escalate rather than edit.

Whether the `avatar-store.ts` aliases survive long-term is a judgement call for the reviewer: they exist so this task stays a pure move. If lint's no-unused/`knip` flags them, prefer repointing profile.ts and local-avatar-store.ts at `image-sniff.js` directly and deleting the aliases — but do that as a visible decision, not silently.

Acceptance: `pnpm vitest run apps/server/src/services/identity/__tests__/image-sniff.test.ts` green; `pnpm vitest run apps/server/src/routes/__tests__/profile-avatar.test.ts` green with zero edits to that file; `pnpm --filter @dorkos/server typecheck` and `pnpm --filter @dorkos/server lint` green; `grep -rn 'PNG_MAGIC\|RIFF_MAGIC' apps/server/src` returns hits in `image-sniff.ts` only.

### Task 1.4: Build RoomAttachmentStore, LocalRoomAttachmentStore, attachment-paths, and prove the seam

- **Size:** large · **Priority:** high
- **Depends on:** 1.1, 1.3 · **Parallel with:** —

New directory `apps/server/src/services/rooms/attachments/` with four files. This follows `apps/server/src/services/identity/{avatar-store,local-avatar-store}.ts` closely enough that you should read both before writing a line.

**`room-attachment-store.ts`** — the port, plus the error class:

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

export class InvalidRoomAttachmentIdError extends Error {
  constructor(id: string) {
    super(`Not a usable room attachment id: ${JSON.stringify(id)}`);
    this.name = 'InvalidRoomAttachmentIdError';
  }
}
```

The module TSDoc must state the seam's contract in one paragraph: `put` answers the URL and nothing above it builds a path; `localPath` answering `null` is the HONEST signal that the projector (task 3.3) must fetch rather than link.

**`local-room-attachment-store.ts`** — the only implementation. Copy the discipline of `LocalAvatarStore` exactly:

- **`dorkHome` arrives through the constructor**, never `resolveDorkHome()` inside the class. VERIFIED: `LocalAvatarStore`'s constructor is `constructor(dorkHome: string) { this.dir = path.join(dorkHome, 'avatars'); }` (local-avatar-store.ts:76-78) and the single call to `resolveDorkHome()` lives at `apps/server/src/index.ts:357`. `os.homedir()` is banned in `apps/server/src` (Hard Rule 3) and this file is not one of the three carve-outs.
- Layout `path.join(dorkHome, 'rooms', roomId, 'attachments')`, file `${attachmentId}.${extension}` — with a bare `attachmentId` when `extension` is `''` (no trailing dot).
- The SAME id allowlist, VERBATIM from local-avatar-store.ts:54: `const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;` — applied to `roomId` AND `attachmentId`, both of which reach this module from a URL path segment. A violation throws `InvalidRoomAttachmentIdError`.
- The SAME double guard: allowlist first, then prove the resolved path is still inside the directory. Model on `fileFor` (local-avatar-store.ts:197-202): `const file = path.resolve(dir, name); if (path.dirname(file) !== path.resolve(dir)) throw new InvalidRoomAttachmentIdError(id);`
- The extension is also untrusted (it comes off a filename) — run it through a `^[A-Za-z0-9]*$` check, or reuse `SAFE_ID` with the empty string allowed, and refuse otherwise.
- ETag: hash the file ON THE WAY OUT so it cannot drift from the bytes, exactly as `LocalAvatarStore.get` does — `createHash('sha256').update(bytes).digest('hex').slice(0, 16)` wrapped in literal double quotes: `` etag: `"${hash}"` ``.
- `put`: `mkdir(dir, { recursive: true })`, write to `${file}.${randomUUID()}.tmp`, then `rename` onto the target — the temp-then-rename ordering `LocalAvatarStore.put` uses (local-avatar-store.ts:135-146) so an interrupted write never leaves a truncated file where a whole one was. Returns `{ url: '/api/rooms/<roomId>/attachments/<attachmentId>' }` with both segments `encodeURIComponent`'d.
- `get`: read the file, return `null` on `ENOENT` via the `readIfPresent` shape (local-avatar-store.ts:227-234), otherwise `{ stream: createReadStream(file), contentType, etag, size }`. `contentType` is passed in by the caller from the row — this store never decides what a file is.
- `deleteRoom`: `rm(path.join(dorkHome, 'rooms', roomId, 'attachments'), { recursive: true, force: true })` — `force: true` is what makes it idempotent.

**`attachment-paths.ts`** — the ONE function that both the context builder (3.1) and the projector (3.3) call, so what the model is told and what is on disk cannot drift:

```ts
/** Where a projected attachment sits, relative to the agent's working directory. */
export function projectedAttachmentPath(
  entryId: string,
  attachmentId: string,
  name: string
): string {
  return path.posix.join('.dork', '.temp', 'room-attachments', entryId, `${attachmentId}-${name}`);
}

/** The directory every projection of one entry lands in, relative to the agent's cwd. */
export function projectedEntryDir(entryId: string): string;

/** The root the 24-hour sweep walks, relative to the agent's cwd. */
export const PROJECTED_ATTACHMENTS_ROOT = '.dork/.temp/room-attachments';
```

`path.posix` on purpose: this string is written into a model's context and compared against itself across runs, so it must not change shape on Windows. The projector joins it onto `agentPath` with the platform `path.join`.

**Tests**, `apps/server/src/services/rooms/attachments/__tests__/`:

`local-room-attachment-store.test.ts` — **filesystem isolation is by constructor injection into an OS temp dir, never the real dorkHome.** Copy the pattern from `apps/server/src/services/identity/__tests__/local-avatar-store.test.ts:52-63` verbatim in shape:

```ts
let dorkHome: string;
let store: LocalRoomAttachmentStore;
beforeEach(async () => {
  dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-room-attachments-'));
  store = new LocalRoomAttachmentStore(dorkHome);
});
afterEach(async () => {
  await rm(dorkHome, { recursive: true, force: true });
});
```

No `DORK_HOME` env var and no `vi.mock` of `dork-home.ts` are needed or wanted — the constructor parameter has no fallback, which is what makes the isolation structural.
Cases: put/get round-trips the bytes; the ETag equals the sha256-16 of the content and CHANGES when the bytes change; `localPath` answers a real path that `readFile` can open; `get` on an id that was never written answers `null`; `deleteRoom` twice is a success both times; and the traversal table — `it.each(['../escape', 'a/b', '..', '', '.', 'a\0b'])` refused with `InvalidRoomAttachmentIdError`, for BOTH the roomId and the attachmentId position. **Mutation evidence required:** loosening `SAFE_ID` to `/^[A-Za-z0-9._-]+$/` (allowing a leading dot) must turn the traversal test RED. Record that you ran it that way and saw the red.

`room-attachment-store.test.ts` — the seam, asserted rather than promised. Model it on `apps/server/src/routes/__tests__/profile-avatar.test.ts`'s `describe('the seam', ...)` (lines 273-307), which is the shape that makes the sync-ready claim falsifiable:

```ts
const cdn: RoomAttachmentStore = {
  put: async () => ({ url: 'https://cdn.example/x.bin' }),
  get: async () => null,
  localPath: async () => null,
  deleteRoom: async () => {},
};
```

At this phase assert only what is reachable: the store satisfies the interface, `put` answers the absolute URL unchanged, and `localPath` answers `null`. The route half ("the cockpit serves that URL unchanged") lands in task 2.5's gate and the projector half ("a null localPath takes the fetch branch") in task 3.3 — this file is where all three eventually live, so write it with that in mind and leave the two later cases as the tasks that add them, not as `it.todo`.

Acceptance: `pnpm vitest run apps/server/src/services/rooms/attachments` green; `pnpm --filter @dorkos/server typecheck` and `pnpm --filter @dorkos/server lint` green (jsdoc is error-level — every export needs TSDoc); `grep -n 'os.homedir' apps/server/src/services/rooms/attachments/` returns nothing.

### Task 1.5: Phase-1 gate — schemas, migration, and store are green and reach nothing yet

- **Size:** small · **Priority:** high
- **Depends on:** 1.2, 1.4 · **Parallel with:** —

The phase-1 verification gate. Nothing user-facing exists yet; what this proves is that the foundation is sound and inert.

Run and record, from the worktree root:

1. `pnpm --filter @dorkos/shared build` FIRST — a stale `@dorkos/shared` dist is this repo's classic false red and every command below resolves through it.
2. `pnpm --filter @dorkos/shared typecheck` · `pnpm --filter @dorkos/db typecheck` · `pnpm --filter @dorkos/server typecheck` — all green.
3. `pnpm --filter @dorkos/server lint` · `pnpm --filter @dorkos/db lint` — green, including `jsdoc` on every new export.
4. `pnpm vitest run packages/db/src/__tests__/migrations.test.ts` — green, and confirm the red-before-green from task 1.2: reverting the `'room_attachments'` line in the hardcoded table array must fail this file. State in the gate notes that you saw it fail.
5. `pnpm --filter @dorkos/db run db:check` — green (`assert-migrations-current.sh` re-runs drizzle-kit and fails if schema and committed migrations disagree, and fails outright rather than passing silently if the generator needed an interactive answer).
6. `pnpm vitest run apps/server/src/services/rooms/attachments` — green.
7. `pnpm vitest run apps/server/src/services/identity` and `pnpm vitest run apps/server/src/routes/__tests__/profile-avatar.test.ts` — green, proving the task-1.3 sniffer move broke nothing that already worked.
8. `pnpm vitest run apps/server/src/services/rooms` — the existing room suites pass untouched. The new nullable-FK table must change nothing about how an entry is written today.

Inertness proofs, all of which must hold:

- `grep -rn 'roomAttachments' apps/server/src` returns hits ONLY under `services/rooms/attachments/` — no route, service, or context file references the table yet.
- `grep -rn 'attachmentIds\|RoomAttachmentSchema' apps/server/src apps/client/src` returns nothing outside the shared package. The schema fields are optional and unread; adding them must not have changed a single response body.
- `pnpm knip` reports the new store exports as reachable-or-expected; a new orphan here means the wiring in phase 2 is going to be wrong.

Hard-rule sweep for everything phase 1 added: `grep -rn 'os.homedir' apps/server/src/services/rooms/` empty; no `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` / `@opencode-ai/sdk` import outside its adapter dir; every new exported symbol carries TSDoc.

Acceptance: every command above green, every grep as described, and the red-before-green for the migration table list explicitly witnessed.

## Phase 2 — Server routes and binding

### Task 2.1: Give appendEntry a post-insert hook — the within(tx) bind the spec describes cannot work

- **Size:** medium · **Priority:** high
- **Depends on:** 1.5 · **Parallel with:** —

**THE SPEC IS WRONG HERE AND THIS TASK IS THE FIX. Read the whole item before writing code.**

The spec says the attachment bind "rides `writePost`'s existing `within(tx)` hook — the same seam `postExternal` uses". VERIFIED against the tree, that cannot work:

- `RoomStore.appendEntry` (`apps/server/src/services/rooms/room-store.ts:479`) opens `this.db.transaction((tx) => { ... }, { behavior: 'immediate' })` and calls `within?.(tx)` as its **FIRST statement**, before it allocates `seq` and before it inserts the `room_entries` row.
- `writePost`'s own TSDoc says so explicitly (`room-service.ts:1493-1497`): "Extra writes to run inside the entry's own transaction, **strictly BEFORE the entry is inserted**".
- `createDb` sets `sqlite.pragma('foreign_keys = ON')` (`packages/db/src/index.ts:31`), and drizzle's `foreignKey()` builder emits no `DEFERRABLE INITIALLY DEFERRED` clause, so the composite FK from `room_attachments(room_id, entry_id)` to `room_entries(room_id, id)` added in task 1.2 is checked IMMEDIATELY, at statement time.
- Therefore `UPDATE room_attachments SET entry_id = ? ...` inside `within(tx)` runs while the parent row does not yet exist and fails with `FOREIGN KEY constraint failed`.

Why the two existing `within`/`recordRef` users do not hit this: `postExternal`'s `within` writes a `room_members` row, which has no FK to `room_entries`; and `recordRef` writes `room_bridge_messages`, which — VERIFIED — declares **no** `foreignKey` at all in `packages/db/src/schema/bridges.ts`. Attachments are the first child of `room_entries` written in the same transaction as its parent.

**The fix — add a post-insert hook, keep the FK.** Do NOT drop the foreign key: the constraint is what makes "a bound attachment always points at a real entry" a fact rather than a convention, and ADR 260807-233815 sells exactly that.

1. `apps/server/src/services/rooms/room-store.ts` — `appendEntry` gains a third parameter:
   ```ts
   appendEntry(
     entry: NewRoomEntry,
     within?: (tx: DbTransaction) => void,
     bind?: (tx: DbTransaction, seq: number) => void
   ): RoomEntry
   ```
   Call `bind?.(tx, seq)` inside the same transaction, AFTER the `tx.insert(roomEntries)...run()` and after the `tx.update(rooms).set({ lastActivityAt })...run()`, immediately before the `return { roomId, seq, ... }` object. Its TSDoc must state the contrast with `within` in one sentence and say WHY both exist: `within` runs before the insert so a membership row covers the whole life of the entry; `bind` runs after it so a child row with a foreign key onto the entry has a parent to point at. Both are inside one transaction, so all three writes land or none does.
2. `apps/server/src/services/rooms/room-service.ts` — `writePost` (line 1507) gains `bind` alongside `recordRef` on its `opts` object: `bind?: (entryId: string, tx: DbTransaction) => void`. It is composed into the third argument of `appendEntry`, not into the `transactional` callback that already composes `within` + `recordRef` (room-service.ts:1546-1556). The entry id is already minted at `const id = ulid();` (line 1542), so `bind` receives it the same way `recordRef` does. Document it in `writePost`'s param list beside the existing `@param opts.recordRef`.

**Red-before-green proof, required.** Add `apps/server/src/services/rooms/__tests__/room-store-bind-hook.test.ts` that:

- (RED FIRST) writes an unbound `room_attachments` row, then calls `appendEntry` passing the attachment UPDATE through `within` — and asserts it throws with a message containing `FOREIGN KEY constraint failed`. Run this against the tree BEFORE adding the `bind` hook and record the failure text. This is the evidence that the hook is necessary rather than tidy.
- (GREEN) the same write through `bind` succeeds, and afterwards exactly one `room_entries` row and one bound `room_attachments` row exist.
- (ATOMICITY) a `bind` callback that throws leaves **no** entry row and **no** bound attachment — the transaction rolls the insert back too. Assert both counts are what they were before the call.
- (ORDERING STILL HOLDS) a `within` callback still runs before the insert: have it assert `SELECT COUNT(*) FROM room_entries WHERE id = ?` is 0 at the moment it runs.

Use the existing room test scaffolding — `createTestDb()` from `@dorkos/test-utils/db` and the `createRoomHarness` helper in `apps/server/src/services/rooms/__tests__/room-test-harness.ts`, which is how every other room test builds a real service over a real in-memory SQLite.

This task and 2.2 may land as one commit if the store hook is unused between them; the hook is additive and optional, so the tree compiles either way.

Acceptance: `pnpm vitest run apps/server/src/services/rooms/__tests__/room-store-bind-hook.test.ts` green; `pnpm vitest run apps/server/src/services/rooms` green (the two existing `within` users are untouched); `pnpm --filter @dorkos/server typecheck` green; the FOREIGN KEY failure text from the red run is recorded in the commit message or the work item.

### Task 2.2: Resolve, bind, and roll up attachments in RoomService

- **Size:** large · **Priority:** high
- **Depends on:** 2.1 · **Parallel with:** —

All in `apps/server/src/services/rooms/`. Three pieces: a store for the rows, the resolve-and-bind on write, and the roll-up on every read path.

**1. The row store.** Add `apps/server/src/services/rooms/attachments/attachment-row-store.ts`, modelled on `apps/server/src/services/rooms/reaction-store.ts` (which is the shape the design record points at). It takes `constructor(private readonly db: Db) {}` and exposes:

- `create(row: { roomId; id; authorId; name; extension; mimeType; size; preview }, createdAt: string): void`
- `listUnboundFor(roomId: string, attachmentIds: readonly string[]): AttachmentRow[]` — for resolution
- `bind(roomId: string, attachmentIds: readonly string[], entryId: string, tx: DbTransaction): void` — the UPDATE that runs inside `bind` from task 2.1
- `listFor(roomId: string, entryIds: readonly string[]): Map<string, RoomAttachment[]>` — the roll-up. Copy `ReactionStore.listFor`'s shape VERBATIM in structure (reaction-store.ts:124-155): dedupe with `[...new Set(entryIds)]`, return an empty map for an empty list, one `where(and(eq(roomId), inArray(entryId, wanted)))` query, `.orderBy(entryId, createdAt, id)` so multiple files on one entry keep upload order, then group in JS.
- `get(roomId: string, attachmentId: string): AttachmentRow | null` — for the serve route.
- `deleteRoom(roomId: string): void` — the row half of the store's `deleteRoom`.
  Map a row to the wire `RoomAttachment` in one place, with the `url` coming from the STORE, never rebuilt here.

**2. Resolution and binding in `RoomService`.** `post` (room-service.ts:1380) and the thread-reply path both funnel into `writePost` (1507). Add a private `resolveAttachments(roomId, authorId, ids)` called from `post`/the thread path BEFORE `writePost`, so nothing is written when it refuses. The refusal table, exactly:

| Condition                                                  | Refusal                           |
| ---------------------------------------------------------- | --------------------------------- |
| `ids.length > configManager.get('uploads').maxFiles`       | `TOO_MANY_ATTACHMENTS` (400)      |
| duplicate ids in one request                               | `TOO_MANY_ATTACHMENTS` (400)      |
| id not in this room, or unbound and owned by somebody else | `ATTACHMENT_NOT_FOUND` (404)      |
| id already bound to an entry                               | `ATTACHMENT_ALREADY_POSTED` (409) |

Read the count limit from `configManager.get('uploads').maxFiles` per request — NOT from `ROOM_ATTACHMENT_MAX_PER_ENTRY`, which is the schema's static 50-ceiling. VERIFIED shape at `packages/shared/src/config-schema.ts` lines 967-981: `maxFileSize` default `10 * 1024 * 1024`, `maxFiles` `z.number().int().min(1).max(50).default(10)`, `allowedTypes` default `['*/*']`.

Then pass the resolved ids into `writePost`'s new `opts.bind` (task 2.1) so the UPDATE rides the entry's own transaction:

```ts
bind: (entryId, tx) => this.attachments.bind(room.id, resolvedIds, entryId, tx);
```

**3. The three new error codes.** Add to the `RoomErrorCode` union in `apps/server/src/services/rooms/room-errors.ts` (lines 14-122): `ATTACHMENT_NOT_FOUND`, `ATTACHMENT_ALREADY_POSTED`, `TOO_MANY_ATTACHMENTS`, each with a one-line TSDoc in the style of the existing `PEOPLE_ONLY` comment. `PEOPLE_ONLY` and `ROOM_ARCHIVED` already exist and are reused as-is. Then add their statuses to `STATUS_BY_CODE` in `apps/server/src/routes/rooms.ts` (lines 47-72): `ATTACHMENT_NOT_FOUND: 404`, `ATTACHMENT_ALREADY_POSTED: 409`, `TOO_MANY_ATTACHMENTS: 400`. That map is typed `Record<RoomErrorCode, number>`, so forgetting one is a compile error rather than a runtime 500 — lean on it, do not work around it.

**4. The roll-up on ALL THREE read paths.** Attachments must reach a reader everywhere reactions do, and the way to guarantee that is to extend the ONE function that already does it rather than adding a second. `RoomService.withReactions` (room-service.ts:2088-2101) is called by `listEntries` (1349) and `snapshot` (1782-1807, which serves the SSE hydration and the resume replay). Rename it `withRollups` and have it attach both, chunked the same way with the same `REACTION_LOOKUP_CHUNK = 500` (room-service.ts:161) — the replay is unbounded by construction and SQLite caps bound parameters. Update its TSDoc, which already explains the chunking, to name both side tables.
The live path is separate: `publishEntry` (2124) currently publishes `entry: { ...entry, reactions: [] }` at **line 2131**. It must become `entry: { ...entry, reactions: [], attachments: <the refs just bound> }` — NOT `[]`, because unlike a reaction an attachment exists at the instant the entry does. Thread the resolved refs from `post`/`writePost` into `publishEntry`.

**Tests** — `apps/server/src/services/rooms/__tests__/room-service-attachments.test.ts`, built on `createRoomHarness` from `./room-test-harness.js` like every other room service test:

- binding is atomic: a `bind` failure injected after the entry insert leaves **no** entry and **no** bound row (this overlaps 2.1's test on purpose — here it goes through the real service).
- a second post naming the same id is refused `ATTACHMENT_ALREADY_POSTED`.
- an id from another room is `ATTACHMENT_NOT_FOUND`; so is another author's unbound id.
- more ids than `config.uploads.maxFiles` is `TOO_MANY_ATTACHMENTS`. **Mutation evidence required:** reading the static `ROOM_ATTACHMENT_MAX_PER_ENTRY` (50) instead of the configured value (10) must turn this RED. Set the config to a non-default value in the test so the two numbers cannot coincide.
- duplicate ids in one request is `TOO_MANY_ATTACHMENTS`.
- **Roll-up parity, one test over three paths:** post an entry with two attachments, then assert `listEntries`, `snapshot`, and the live `entry` frame captured off the broadcaster ALL carry the same two refs in the same order. The failure mode this catches is a path somebody forgot, so write it as one test asserting three sources, not three tests.

Acceptance: `pnpm vitest run apps/server/src/services/rooms` green; `pnpm --filter @dorkos/server typecheck` green; `grep -n 'withReactions' apps/server/src` returns nothing (the rename left no second roll-up behind).

### Task 2.3: Add the upload and serve routes, and wire the store at startup

- **Size:** large · **Priority:** high
- **Depends on:** 2.2 · **Parallel with:** —

All in `apps/server/src/routes/rooms.ts` plus one wiring line in `apps/server/src/index.ts`. Read `apps/server/src/routes/profile.ts` first — the upload route is its shape with a membership check instead of an owner check.

**Wiring.** `apps/server/src/index.ts` constructs `new LocalAvatarStore(dorkHome)` at line 2061, with `const dorkHome = resolveDorkHome()` at line 357. Construct `new LocalRoomAttachmentStore(dorkHome)` the same way and pass it into the rooms router / room service the way the profile router receives `avatars`. The comment above the avatar line records the doctrine — the store is chosen HERE and nowhere else, so the day files live somewhere other than this machine, one line changes. Write the equivalent comment.

**`POST /:id/attachments`** — multipart, field name `files`.

- `const caller = resolveCaller(res)` (from `./room-caller.js`, already imported at rooms.ts:41). **Refuse a non-person BEFORE multer runs**, the way `profile.ts:124` does with the comment "Resolved BEFORE multer runs: an agent's upload is refused without its bytes ever being read.": `if (caller.kind !== 'human') throw new RoomError('PEOPLE_ONLY', 'Only a person can attach a file.')`.
- Then membership: reuse the service's visibility+membership path so a non-member gets the same `ROOM_NOT_FOUND` (404) every other room read gives — `requireVisibleRoom` reports 404 for both "no such room" and "not visible to you" on purpose (room-service.ts:1966-1972), and this route must not become the one place that leaks existence.
- An archived room refuses `ROOM_ARCHIVED` (409).
- Build multer PER REQUEST from `configManager.get('uploads')`, as `routes/uploads.ts:26-33` does — same source, same limits. But use **`multer.memoryStorage()`**, not `uploads.ts`'s `diskStorage`: the bytes must be sniffed before anything decides the extension, the mime type, or whether the file may ever be served inline.
  ```ts
  const uploadConfig = configManager.get('uploads');
  const upload = multer({
    storage: multer.memoryStorage(),
    // `+ 1` because busboy refuses a file that REACHES `fileSize`, not one that
    // exceeds it — the reason `routes/profile.ts` records at its own limit.
    limits: { fileSize: uploadConfig.maxFileSize + 1, files: uploadConfig.maxFiles },
    fileFilter: (_req, file, cb) =>
      uploadConfig.allowedTypes.includes('*/*') || uploadConfig.allowedTypes.includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error(`File type not allowed: ${file.mimetype}`)),
  }).array('files', uploadConfig.maxFiles);
  ```
- Error mapping: a `multer.MulterError` with `code === 'LIMIT_FILE_SIZE'` maps to **413** with chat's own sentence, built from the configured value the same way `uploads.ts:38` builds it: `` `File too large (max ${uploadConfig.maxFileSize / 1024 / 1024}MB)` ``. A disallowed type maps to **415**. Anything else multer raises maps to 400.
- Per file, in order: sanitize the name — `path.basename(original)` then `.replace(/[^a-zA-Z0-9._-]/g, '_')`, the regex `upload-handler.ts:9` uses verbatim — truncated to `ROOM_ATTACHMENT_NAME_MAX` (255); take the extension off the SANITIZED name; call `sniffImageContentType(file.buffer)` from `services/identity/image-sniff.js` (task 1.3); when it answers, set `preview: 'image'` and `mimeType` from the SNIFF; when it does not, set `preview: null` and `mimeType` from `file.mimetype` as declared. Then `await store.put(roomId, id, extension, file.buffer)` with `id = ulid()`, then one row through the row store. **Do not derive `preview` from `file.mimetype` under any circumstance** — that is the whole safety property and task 2.5 has a mutation test for it.
- Answer `200 { attachments: RoomAttachment[] }` in request order.

**`GET /:id/attachments/:attachmentId`** — stream one.

- A **bound** attachment is readable by anyone who may read the entry that references it — the same visibility check `GET /:id/entries` makes. Any other rule would let a person read a message and not the file it is about.
- An **unbound** attachment is readable only by the author who uploaded it, so the composer can draw its own chip and nobody can enumerate a stranger's staging area.
- Everything else — wrong room, no such id, somebody else's unbound row — is `404 ATTACHMENT_NOT_FOUND`. Existence is never leaked by a 403.
- Headers, following `GET /api/profile/avatar/:id` (profile.ts:186-197) exactly, in this order: `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Disposition`, `ETag`, `Cache-Control: private, max-age=0, must-revalidate`, plus `Content-Length` from `stored.size`. Then the 304: `if (req.headers['if-none-match'] === stored.etag) { stored.stream.destroy(); return res.status(304).end(); }` — destroy rather than pipe, so the file handle does not leak.
- **`Content-Type` and `Content-Disposition` are decided by the row's `preview` and by nothing else.** `preview === 'image'` → the verified image type and `inline`. Otherwise → `application/octet-stream` and `` `attachment; filename="${name}"` ``. A room accepts every type by default (`allowedTypes: ['*/*']`), so this line is what keeps an uploaded `.html` or SVG from rendering as a document under the cockpit's own origin.
- Copy `profile.ts:199-204`'s stream error handling verbatim in shape: log, `sendError(..., 500, ...)` if headers are not sent, else `res.destroy(streamErr)`.
- Catch `InvalidRoomAttachmentIdError` and answer 400, the way `profile.ts:224-230` catches `InvalidAvatarIdError`.

**`POST /:id/entries` and `POST /:id/threads`** — read `body.attachmentIds` (now on both schemas from task 1.1) and pass it to the service. The handler shape is already established at rooms.ts:193-207: `parseBody(PostToRoomRequestSchema, req.body, res)` → early return → `resolveCaller(res)` → service call → `res.status(202).json(...)` → `catch` → `sendRoomError(res, err, 'POST /:id/entries')`. Change nothing else about them; the 202 trigger-only contract stands.

**Express 5 note:** `req.body` is `undefined` on an empty POST. The multipart route never reads `req.body`, and the two JSON routes already go through `parseBody`, which handles it — do not add a second guard.

**Tests** — `apps/server/src/routes/__tests__/rooms-attachments.test.ts`, built on `supertest` + `express()` + `createTestDb()` the way `profile-avatar.test.ts` is (lines 12-24, 56-99), with the store constructed over an `mkdtemp` temp dir and torn down in `afterEach`:

- an agent caller is refused `PEOPLE_ONLY` (403) and **no file was written** — assert the room's attachment directory does not exist afterwards, which is what proves the refusal beat multer.
- a non-member is refused 404.
- an archived room is refused 409.
- over-size maps to 413 with the configured megabyte figure in the message; test the boundary both ways (exactly `maxFileSize` → 200, one byte more → 413), as `profile-avatar.test.ts:169-182` does.
- a `.png` full of GIF bytes stores with `preview: null` and is served `application/octet-stream` + `Content-Disposition: attachment`. **Mutation evidence required:** setting `preview` from `file.mimetype.startsWith('image/')` must turn this RED.
- a real PNG is served `image/png` + `inline`.
- `If-None-Match` with the returned ETag gets a 304 and no body.
- a bound attachment is readable by a second member; an unbound one is not (404), and the uploader can read their own unbound one.
- path traversal in `:attachmentId` — `['..%2Fsecret', '..', '%2e%2e%2f%2e%2e%2fetc%2fpasswd']` all 404, the table `profile-avatar.test.ts:264-270` uses.

Acceptance: `pnpm vitest run apps/server/src/routes/__tests__/rooms-attachments.test.ts` green; `pnpm vitest run apps/server/src/routes` green; `pnpm --filter @dorkos/server typecheck` and `lint` green.

### Task 2.4: Register both routes in the OpenAPI registry and regenerate the API docs

- **Size:** small · **Priority:** medium
- **Depends on:** 2.3 · **Parallel with:** —

Two new paths and two changed request bodies.

In `apps/server/src/services/core/openapi-registry.ts`, the room paths live at lines 3149-3513, all `tags: ['Rooms']`. Add two `registry.registerPath({ ... })` calls beside `POST /api/rooms/{id}/entries` (registered at line 3271), copying its structure verbatim — it is the canonical example:

```ts
registry.registerPath({
  method: 'post',
  path: '/api/rooms/{id}/attachments',
  tags: ['Rooms'],
  summary: 'Upload files into a room, before the message that carries them',
  description:
    'Multipart, field name `files`. Only a person who is a member of the room may upload; an agent is refused before its bytes are read. Limits come from the `uploads` section of user config — the same limits chat uses. The response carries one `RoomAttachment` per file, in request order; a following `POST /api/rooms/{id}/entries` names them by id in `attachmentIds`, and the server binds them to the entry inside the entry\'s own transaction.',
  request: {
    params: RoomIdParams,
    body: { content: { 'multipart/form-data': { schema: /* files: array of binary */ } } },
  },
  responses: {
    200: {
      description: 'Stored; ids to reference in the post that follows',
      content: { 'application/json': { schema: RoomAttachmentUploadResponseSchema } },
    },
    400: roomValidationError,
    403: { description: 'Only a person can attach a file', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: roomNotFound,
    409: { description: 'The room is archived', content: { 'application/json': { schema: ErrorResponseSchema } } },
    413: { description: 'A file is larger than the configured limit', content: { 'application/json': { schema: ErrorResponseSchema } } },
    415: { description: 'A file\'s type is not in the configured allowlist', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
```

and `GET /api/rooms/{id}/attachments/{attachmentId}` with a `200` of `content: { '*/*': { schema: { type: 'string', format: 'binary' } } }`, `304` (not modified), `400` (unusable id), and `404` (no such attachment, or not yours to read). Reuse the file's existing `RoomIdParams`, `roomNotFound`, `roomValidationError` and `ErrorResponseSchema` helpers rather than writing new ones; follow whatever multipart registration pattern the profile avatar upload already uses in this file, if one exists — grep for `multipart` before inventing a shape.

The two CHANGED request bodies need no registry edit: `PostToRoomRequestSchema` and `PostThreadReplyRequestSchema` are referenced by identity, so the `attachmentIds` field added in task 1.1 flows through automatically. Confirm that in the regenerated JSON rather than assuming it.

Regenerate: `pnpm docs:export-api` (root script → `tsx scripts/export-openapi.ts`, writes `docs/api/openapi.json`). Commit the regenerated file and any `docs/api/**` pages the Fumadocs plugin derives from it. The spec's Blast Radius notes the freshness check must be run before the PR opens — do it here, not at the end.

Acceptance: `pnpm docs:export-api` runs clean and `git diff --stat docs/api/` shows exactly the two new paths and the two changed request bodies and nothing else; `node -e` / `jq` confirms `RoomAttachment`, `RoomAttachmentPreview` and `RoomAttachmentUploadResponse` appear in `docs/api/openapi.json` components and that `PostToRoomRequest.properties.attachmentIds` exists; `pnpm --filter @dorkos/server typecheck` green.

### Task 2.5: Phase-2 gate — a file can be uploaded, bound atomically, and served safely

- **Size:** small · **Priority:** high
- **Depends on:** 2.4 · **Parallel with:** —

The phase-2 verification gate. After this the server half is complete and nothing on screen has changed.

Run and record, from the worktree root:

1. `pnpm --filter @dorkos/shared build` first (stale-dist false reds).
2. `pnpm --filter @dorkos/server typecheck` · `pnpm --filter @dorkos/server lint` — green.
3. `pnpm vitest run apps/server/src/services/rooms` — green, all suites.
4. `pnpm vitest run apps/server/src/routes/__tests__/rooms-attachments.test.ts` and `pnpm vitest run apps/server/src/routes` — green.
5. `pnpm vitest run packages/db` — green.

Complete the seam test started in task 1.4. Add to `apps/server/src/services/rooms/attachments/__tests__/room-attachment-store.test.ts` the route half, which is what makes "sync-ready" falsifiable rather than aspirational — the exact shape `profile-avatar.test.ts:273-307` uses for `AvatarStore`:

- with `put` answering `'https://cdn.example/x.bin'` and `localPath` answering `null`, an upload through the real route returns that absolute URL **unchanged** in `RoomAttachment.url`, the row stores it, and a subsequent read of the entry carries it verbatim to the reader.
- assert **nothing was written to this machine**: `await expect(readdir(path.join(dorkHome, 'rooms'))).rejects.toThrow()`, the assertion `profile-avatar.test.ts` makes for avatars. The route never touched a path.

The three mutation proofs introduced in this phase, each explicitly re-run in its mutated form and witnessed red before being restored:

- deriving `preview` from `file.mimetype` instead of the sniff → the GIF-bytes-in-a-`.png` test in `rooms-attachments.test.ts` goes red.
- reading `ROOM_ATTACHMENT_MAX_PER_ENTRY` instead of `config.uploads.maxFiles` → the `TOO_MANY_ATTACHMENTS` test in `room-service-attachments.test.ts` goes red.
- moving the attachment bind from `bind` back to `within` → the FK test from task 2.1 goes red with `FOREIGN KEY constraint failed`.

Inertness proofs — the client has not changed and must not have:

- `git diff --stat <phase-1 base> -- apps/client` is EMPTY. Phases 1-3 touch no client file.
- `pnpm vitest run apps/client/src/layers/widgets/room-view` green with zero edits (run it from `apps/client` — see the gotcha in task 4.3).

Hard-rule sweep across everything phases 1-2 added: `grep -rn 'os.homedir' apps/server/src/services/rooms apps/server/src/routes/rooms.ts` empty; no runtime SDK import outside its adapter directory; `pnpm --filter @dorkos/server lint` reports no `jsdoc` error, meaning every new export is documented.

Acceptance: every command green, the seam test's two new cases passing, and all three mutations witnessed red and restored.

## Phase 3 — Agent delivery

### Task 3.1: Carry attachment paths on RoomContextEntry and fill them from the roll-up

- **Size:** medium · **Priority:** high
- **Depends on:** 2.5 · **Parallel with:** —

The agent has to be TOLD about the files before anything can project them. This task adds the field and fills it; task 3.3 makes the paths real.

**1. The wire type.** `packages/shared/src/additional-context.ts` — `RoomContextEntry` is at lines 190-240, its Zod twin `RoomContextEntrySchema` at line 533. Add to BOTH, after `mentionsMe`:

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

Make it required, not optional — every builder of a `RoomContextEntry` is in this repo, and an optional field here would let a path silently go missing. The Zod twin gets `z.array(z.object({ name: z.string(), path: z.string() }))`.

**2. The lookup dep.** `buildRoomContext` reaches the database only through `RoomContextDeps`. Follow `topicNamesFor` exactly — it is the same shape of question and the precedent to copy:

- `apps/server/src/services/rooms/room-context.ts:131` declares `topicNamesFor(entryIds: readonly string[]): Map<string, string>;`. Add beside it `attachmentsFor(entryIds: readonly string[]): Map<string, RoomAttachment[]>;`
- `apps/server/src/services/rooms/room-trigger.ts:198` declares the same method on `RoomTriggerDeps`. Add it there too.
- `apps/server/src/services/rooms/room-service.ts:328` supplies it: `topicNamesFor: (entryIds) => topicNamesForEntries(this.bridges, entryIds),`. Add `attachmentsFor: (entryIds) => this.attachments.listFor(roomIdInScope, entryIds),` using the row store from task 2.2 — check how `roomId` is in scope at that construction site and thread it the way `topicNamesForEntries` threads `this.bridges`; if it is not, give the dep a `(roomId, entryIds)` signature rather than closing over a room the deps object does not know.

**3. The fill.** `buildRoomContext` (room-context.ts:174) already resolves the window and, at line 215, calls `deps.topicNamesFor([...missed, ...ownRecent].map((entry) => entry.id))`. Call `deps.attachmentsFor` over the SAME id list on the next line, and have `flatten` (lines 260-280) set `attachments` from it via the shared helper from task 1.4:

```ts
attachments: (attachmentsByEntry.get(entry.id) ?? []).map((a) => ({
  name: a.name,
  path: projectedAttachmentPath(entry.id, a.id, a.name),
})),
```

The window is capped at `PENDING_MAX_ENTRIES = 30` (room-context.ts:66) plus `OWN_RECENT_MAX_ENTRIES = 5` (line 69) — that cap is what bounds the projection in task 3.3, so nothing here may widen it.

**4. The projection plan, and why the return type changes.** Task 3.3's projector must project EXACTLY the files the model is told about — "scoped to what the model is actually shown" is the invariant ADR 260807-233816 rests on. `RoomContextEntry` carries no entry id and no attachment id, so a projector reading the built context would have to reverse-parse its own path strings; and a projector running its own query would make the lockstep a convention rather than a fact.

So change `buildRoomContext`'s return type to `{ context: RoomContextData; projection: ProjectableAttachment[] }`, where `ProjectableAttachment` is `{ entryId: string; attachmentId: string; extension: string; name: string; relativePath: string }` — built in the same pass as the fill, from the same map. There is exactly ONE production call site: `apps/server/src/services/rooms/room-trigger.ts:821`, `roomContext: buildRoomContext(this.deps, { ... })`. It becomes two lines, and the plan rides `RoomTurnRequest` alongside `roomContext` for task 3.3 to consume.
RECORD THE REJECTED ALTERNATIVE in the function's TSDoc: a second, independent query in the turn runner was rejected because it makes "the model is only told about files it can open" a thing two code paths have to keep agreeing about, and the failure mode — an agent told about a file that was never projected — is silent.

**Tests** — extend `apps/server/src/services/rooms/__tests__/room-context.test.ts`, which deliberately drives the REAL service and dispatcher through `createRoomHarness` rather than calling `buildRoomContext` directly (its module doc says reaching for the function directly "would prove the function composes and nothing about what a message in a room causes"). Keep that discipline:

- an entry posted with two attachments produces two `{ name, path }` entries on the corresponding `RoomContextEntry`, in upload order, with paths of the form `.dork/.temp/room-attachments/<entryId>/<attachmentId>-<name>`.
- an entry with none produces `[]`, never `undefined`.
- the returned `projection` plan names exactly the attachments of the entries in `context.pending` + `context.ownRecent` and nothing else. **This is the discriminating assertion:** post an attachment on an entry that falls OUTSIDE the 30-entry window and assert it is absent from both.

Acceptance: `pnpm vitest run apps/server/src/services/rooms/__tests__/room-context.test.ts` green; `pnpm vitest run apps/server/src/services/rooms` green; `pnpm --filter @dorkos/shared build && pnpm --filter @dorkos/server typecheck` green.

### Task 3.2: Render the attachment paths as a bracketed suffix on the entry line

- **Size:** small · **Priority:** high
- **Depends on:** 3.1 · **Parallel with:** 3.3

**DRIFT NOTE:** the spec calls this file `room-context-block.ts` without a directory. VERIFIED path is `apps/server/src/services/runtimes/shared/room-context-block.ts` (650 lines) — under `runtimes/shared/`, not under `services/rooms/`.

`entryLine` is at lines 383-399 and reads, verbatim:

```ts
function entryLine(entry: RoomContextEntry): string {
  const author = { handle: entry.authorHandle, displayName: entry.authorDisplayName };
  const who = entry.kind === 'notice' ? 'the room' : named(author);
  const from = entry.authorOrigin === 'external' ? `, ${EXTERNAL_MARK}` : '';
  const what =
    entry.kind === 'notice'
      ? ''
      : ` (${entry.authorIsPerson ? 'person' : 'agent'}${from}${addressNote(author)})`;
  const topic = entry.topicLabel ? ` [topic: ${label(entry.topicLabel, TOPIC_MAX_LENGTH)}]` : '';
  const mention = entry.mentionsMe ? ' [mentions you]' : '';
  return `[${clock(entry.at)}] ${who}${what}${topic}${mention}: ${body(entry.text)}`;
}
```

Add one more bracketed suffix in the same shape, between `mention` and the body:

```ts
const attached =
  entry.attachments.length > 0
    ? ` [attached: ${entry.attachments.map((a) => label(a.path)).join(', ')}]`
    : '';
```

and include `${attached}` in the template after `${mention}`. Producing, for one file:

```
[14:02] Ana (person, @ana): here is the crash …  [attached: .dork/.temp/room-attachments/01J…/01J…-crash.log]
```

**Both values go through `label()`.** It is module-private in this file at lines 175-177 — `sanitizeIdentity(value, maxLength) ?? \`${UNNAMEABLE}-${discriminator(value)}\``— and`.claude/rules/room-conduct.md`is explicit that labels may sit outside the untrusted fence ONLY after`sanitizeIdentity`from`@dorkos/shared/untrusted-text`, and that writing a second sanitizer is how NEL gets missed. The name is already sanitized at write time (task 2.3, `[^a-zA-Z0-9._-] → \_`), so this is the second of the two sanitizations §9.2 requires, exactly as `topicLabel` is sanitized twice.

Decide and document, in one comment, which region this belongs to: a path is a LABEL (server-generated, sanitized, not somebody's words), so it sits outside the fence beside `[topic: …]` — not inside it beside `body(entry.text)`. That classification is the room-conduct two-region test and a reviewer will ask for it.

Do not add a per-entry cap on the number of paths beyond what already bounds it: `config.uploads.maxFiles` (default 10) caps the count at write time.

**Tests** — the existing suite for this file (find it under `apps/server/src/services/runtimes/shared/__tests__/`; if `room-context-block` has no test file yet, add one and say so):

- an entry with one attachment renders the exact bracketed suffix above; with two, they are comma-joined in order.
- an entry with `attachments: []` renders NO suffix at all — no empty brackets, no trailing space.
- **the safety pin:** a name carrying a newline, an angle bracket, or a NEL cannot break the line or forge a chat line. This is already impossible after task 2.3's sanitization; the test pins that it STAYS impossible, which is the point — build the `RoomContextEntry` fixture with a hostile name directly (bypassing the route) so the test is about `label()` and not about the sanitizer upstream.
- the fence's per-turn nonce and the block's surrounding structure are unchanged — assert the rendered block still opens and closes with `--- BEGIN/END UNTRUSTED ROOM MESSAGES <nonce> ---` and that the attachment suffix sits OUTSIDE it.

Acceptance: `pnpm vitest run apps/server/src/services/runtimes/shared` green; `pnpm --filter @dorkos/server typecheck` and `lint` green.

### Task 3.3: Project attachments into the agent's working directory before its turn starts

- **Size:** large · **Priority:** high
- **Depends on:** 3.1 · **Parallel with:** 3.2

New file `apps/server/src/services/rooms/attachments/attachment-projection.ts`, wired into `apps/server/src/services/rooms/room-turn-runner.ts`.

**Why a projection and not an absolute path** (put this in the module TSDoc, because it is the decision, not an implementation note): a room turn runs with `cwd: request.agentPath` (room-turn-runner.ts:202 and :250), the attachment directory is outside it, and a read outside the working directory is what a runtime asks permission for — which would park the turn on `awaiting_approval` and make "automatic" false. Widening the `AgentRuntime` port with a per-turn filesystem grant would need three different answers for claude-code, codex and opencode. So the file is brought to the agent, which is the shape chat already ships (ADR-0100). ADR 260807-233816 is the record.

**The function:**

```ts
export async function projectRoomAttachments(input: {
  store: RoomAttachmentStore;
  roomId: string;
  agentPath: string;
  attachments: readonly ProjectableAttachment[];
  now?: () => number;
}): Promise<void>;
```

Behavior, each point load-bearing:

- **Hardlink first, copy on failure.** `<dorkHome>` and the default agents directory (`~/.dork/agents`) are normally the same filesystem, so `fs.link` costs an inode and no bytes. Catch `EXDEV` and `EPERM` and fall back to `copyFile`. **There is no hardlink prior art in this repo** — VERIFIED, `grep` for `fs.link` / `EXDEV` finds only `apps/server/src/services/marketplace/lib/atomic-move.ts`, which is rename-with-copy-fallback, not link. Read it anyway for the `EXDEV` type-guard shape (`(err as { code?: string }).code === 'EXDEV'`) and reuse that guard rather than writing a third one.
- **Fetch when the bytes are not local.** `await store.localPath(...)` answering `null` is the honest signal from a future remote store: fetch the URL and write the file instead of linking.
- **Idempotent.** A projection that already exists is left alone — one `stat` per file — so re-triggering an agent in a busy room costs nothing.
- **Scoped.** It projects exactly the `ProjectableAttachment[]` plan task 3.1 built from the model's own 30-entry window. It must not query for more.
- **Swept on the way in.** Each run removes entry directories under `{agentPath}/.dork/.temp/room-attachments/` whose mtime is older than 24 hours, so the tree does not grow without bound and no scheduler is introduced. Take `now` as an injectable so the sweep is testable without fake timers.
- Destination `path.join(agentPath, projectedAttachmentPath(entryId, attachmentId, name))` using the shared helper from task 1.4 — never a second path expression. `mkdir(dirname, { recursive: true })` first.
- A projection failure must NOT fail the turn. Log a warning through the existing `logger` and continue: an agent that gets the words but not one file is far better than a room that stops answering. Say so in the TSDoc.

**Wiring.** In `room-turn-runner.ts`'s `run`, the insertion point is between `const prompt = request.entry.body.text;` (line 215) and the `triggerTurn({ ... })` call (line 246). `request.agentPath` is already in scope (used at 202 and 250). `await projectRoomAttachments(...)` there, taking the plan off the `RoomTurnRequest` field task 3.1 added. Do NOT touch line 215 itself — the comment above it records that the prompt IS the message byte for byte (ADR-0273), and this work adds nothing to it.

**Tests** — `apps/server/src/services/rooms/attachments/__tests__/attachment-projection.test.ts`, over a REAL temp filesystem (`mkdtemp(path.join(tmpdir(), ...))` for both the store's dorkHome and the fake agentPath, `rm(..., { recursive: true, force: true })` in `afterEach`), which is where these failure modes actually live:

- a projection is a hardlink when possible — assert it by `stat().nlink === 2`, or by writing through one path and reading the change at the other. `nlink` is the assertion that actually discriminates a link from a copy.
- when `link` throws `EXDEV`, the copy branch runs and the destination holds the same bytes. Inject the failure with a scoped `vi.mock('fs/promises', ...)` that passes everything else through to `actual` — the technique `apps/server/src/services/identity/__tests__/local-avatar-store.test.ts:22-37` uses for `rename`, which is the pattern to copy.
- a second run is a no-op: capture the destination's inode/mtime, run again, assert unchanged.
- a 25-hour-old entry directory is swept and a 23-hour-old one is not. Set mtimes with `utimes` and drive `now`.
- `store.localPath()` answering `null` takes the fetch branch — this completes the third case of the seam test started in task 1.4.
- a projection error does not throw out of `projectRoomAttachments`.
  Add one case in `apps/server/src/services/rooms/__tests__/room-turn-runner.test.ts` (which stubs `triggerTurn` and builds a `RoomTurnRequest` fixture at lines 147-217): a request carrying a projection plan has its files on disk under `agentPath` before `triggerTurn` is called. Assert the ordering, not just the end state.

Acceptance: `pnpm vitest run apps/server/src/services/rooms/attachments` green; `pnpm vitest run apps/server/src/services/rooms/__tests__/room-turn-runner.test.ts` green; `pnpm --filter @dorkos/server typecheck` and `lint` green.

### Task 3.4: Phase-3 gate — every path an agent is told about is one it can open

- **Size:** small · **Priority:** high
- **Depends on:** 3.2, 3.3 · **Parallel with:** —

The phase-3 verification gate. The whole server is done after this; the cockpit still shows nothing.

Run and record, from the worktree root:

1. `pnpm --filter @dorkos/shared build`, then `pnpm --filter @dorkos/shared typecheck` and `pnpm --filter @dorkos/server typecheck` — green.
2. `pnpm --filter @dorkos/server lint` — green (jsdoc error-level).
3. `pnpm vitest run apps/server/src/services/rooms` — every room suite green, including `room-context.test.ts`, `room-turn-runner.test.ts`, and the four `room-context-*` variants.
4. `pnpm vitest run apps/server/src/services/runtimes/shared` — green.
5. `pnpm vitest run apps/server` — green.

The phase's discriminating claim, asserted rather than assumed: **the set of paths the model is told about equals the set of files on disk.** Add one test that proves it end-to-end over a real temp filesystem — build a room with more entries than the 30-entry window, attachments on entries both inside and outside it, run a triggered turn through the harness, then assert that for every `attachments[].path` appearing anywhere in the rendered context block, `fs.access(path.join(agentPath, thatPath))` succeeds; and that no file was projected for an entry outside the window. If those two sets can disagree, the projector and the context builder have drifted and ADR 260807-233816's central promise is false.

Room-conduct proof: the rendered block still opens and closes with its per-turn nonce fence, the attachment suffix sits outside it beside `[topic: …]`, and a hostile filename cannot break a line (task 3.2's pin).

Inertness proof: `git diff --stat <phase-1 base> -- apps/client apps/e2e` is still EMPTY. Nothing user-facing has moved.

Hard-rule sweep for phase 3: no `os.homedir()` under `apps/server/src/services/rooms/`; no runtime SDK import outside its adapter dir (the projector uses none — it is deliberately runtime-agnostic, which is the whole point of ADR 260807-233816, so assert `grep -rn '@anthropic-ai/claude-agent-sdk\|@openai/codex-sdk\|@opencode-ai/sdk' apps/server/src/services/rooms/` is empty); every new export documented.

Acceptance: every command green, the paths-equal-files test passing, and the client diff still empty.

## Phase 4 — Client

### Task 4.1: Add uploadRoomAttachments to the transport, generalize the upload helper, and stub embedded mode

- **Size:** medium · **Priority:** high
- **Depends on:** 3.4 · **Parallel with:** 4.4

**DRIFT NOTE:** the spec says "`HttpTransport` implements it by generalizing `uploadFilesOverHttp`". VERIFIED paths — `uploadFilesOverHttp` lives at `apps/client/src/layers/shared/lib/transport/upload-methods.ts:39-158`, the room methods at `apps/client/src/layers/shared/lib/transport/room-methods.ts` (built by `createRoomMethods`, imported into `http-transport.ts:21`), and the stubs at `apps/client/src/layers/shared/lib/embedded-mode-stubs.ts` (`roomStubs`, lines 808-874). Nothing is in `http-transport.ts` itself.

**1. The port.** `packages/shared/src/transport-rooms.ts` — the `RoomTransport` interface spans lines 37-238. Add one method beside `postToRoom` (line 118):

```ts
  /**
   * Upload files into a room, before the message that carries them.
   *
   * Separate from {@link postToRoom} rather than a field on it for the reason
   * the multipart body forces and the access model confirms: bytes and JSON are
   * different requests, and the attachment exists — refusable, retryable, its
   * own progress — before there is an entry to hang it on.
   */
  uploadRoomAttachments(
    id: string,
    files: UploadFile[],
    onProgress?: (progress: UploadProgress) => void,
    signal?: AbortSignal
  ): Promise<RoomAttachment[]>;
```

`UploadFile` is at `packages/shared/src/transport.ts:387-396`; `UploadProgress` at `packages/shared/src/schemas.ts:3413-3439`; `RoomAttachment` comes from `./room-schemas.js` (task 1.1). `postToRoom` and `replyInThread` need no signature change — they inherit `attachmentIds` from the request schemas.

**2. Generalize the helper.** `uploadFilesOverHttp` currently signs as:

```ts
export async function uploadFilesOverHttp(
  baseUrl: string,
  files: UploadFile[],
  cwd: string,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal
): Promise<UploadResult[]>;
```

and POSTs multipart to `` `${baseUrl}/uploads?cwd=${encodeURIComponent(cwd)}` ``. Split it so the **URL is a parameter and the response type is generic**, keeping the XHR progress channel, the silence watchdog, and the cancel semantics **reused verbatim rather than re-derived** — those are the parts DOR-494 paid for:

```ts
async function uploadOverHttp<T>(
  url: string,
  field: string,
  files: UploadFile[],
  parse: (body: unknown) => T,
  onProgress?,
  signal?
): Promise<T>;
```

Chat's `uploadFilesOverHttp` becomes a thin caller passing `` `${baseUrl}/uploads?cwd=…` `` and field `'files'`. **Chat's behavior must not change at all** — same URL, same field name, same progress events, same abort. Any test in the chat upload path that needs editing is proof you changed it.

**3. The room implementation.** In `room-methods.ts`, beside `postToRoom` (lines 142-149), add `uploadRoomAttachments` calling the generalized helper against `` `${baseUrl}/rooms/${encodeURIComponent(id)}/attachments` `` with field name `'files'`, parsing `{ attachments }` off the response. No `cwd` anywhere — a room has none, and that is the whole reason this endpoint exists.

**4. Embedded mode.** Add to `roomStubs` in `embedded-mode-stubs.ts` the one-line stub every other room method has, matching them verbatim in shape:

```ts
  async uploadRoomAttachments(): Promise<RoomAttachment[]> {
    throw new Error('Rooms are not supported in embedded mode');
  },
```

That is the entire Obsidian/`DirectTransport` scope of this spec.

**5. The mock transport.** `createMockTransport` in `@dorkos/test-utils` is what every client room test builds on. Add `uploadRoomAttachments` to its default shape so existing tests keep type-checking, defaulting to `async () => []`.

**Tests:** extend whatever suite covers `upload-methods.ts` (find it under `apps/client/src/layers/shared/lib/transport/__tests__/`) with: progress callbacks fire for a room upload; `signal.abort()` rejects and cancels the XHR; the request goes to `/rooms/<id>/attachments` with NO `cwd` query parameter. Assert the chat path's URL is byte-identical to what it was — that is the regression this refactor risks.

Acceptance: `pnpm --filter @dorkos/shared build && pnpm --filter @dorkos/client typecheck` green; `pnpm vitest run apps/client/src/layers/shared/lib/transport` green; `pnpm vitest run apps/client/src/layers/features/chat` green with zero edits to chat tests.

### Task 4.2: Build useRoomAttachments — use-file-upload re-expressed against the room endpoint

- **Size:** medium · **Priority:** high
- **Depends on:** 4.1 · **Parallel with:** 4.4

New file `apps/client/src/layers/widgets/room-view/model/use-room-attachments.ts`, exported from the room-view widget's barrel.

**Why a widget and not an entity:** it needs `PendingFile`, which lives at `apps/client/src/layers/features/composer/model/pending-file.ts` and is exported from the composer barrel (`features/composer/index.ts:75`). The FSD layer rule is `shared ← entities ← features ← widgets` (`.claude/rules/fsd-layers.md`), so an entity may not import a feature and a widget may. Import from the BARREL — `import { type PendingFile } from '@/layers/features/composer'` — never a deep path into the slice.

**Model it on `apps/client/src/layers/features/chat/model/use-file-upload.ts` (179 lines). Read it first.** It is the same hook with two differences: the endpoint it calls, and that it returns **ids** rather than paths.

Signature: `useRoomAttachments(roomId: string)`. Keyed by room id so a thread composer and its room composer — two mounts of `RoomComposer` — do not share a chip bar. Use the thread draft-key convention already in `RoomComposer` (`room.id` vs `threadDraftKey(room.id, threadRootId)`) if the thread panel needs its own bar; decide and document which, and make the test in this task assert it.

Returned object, mirroring `use-file-upload.ts:166-178` name for name so a reader of one recognises the other:

```ts
return {
  pendingFiles,
  addFiles,
  removeFile,
  retryFile,
  clearFiles,
  cancelUpload,
  uploadAndGetIds,
  hasPendingFiles: pendingFiles.length > 0,
  /** True while any attachment failed to upload — the send must not go out. */
  hasFailedUpload: pendingFiles.some((f) => f.status === 'error'),
  isUploading: uploadMutation.isPending,
};
```

The `PendingFile` state machine is unchanged: `'pending' | 'uploading' | 'uploaded' | 'error'`, `addFiles` creates at `'pending'`, the mutation flips to `'uploading'`, `onSuccess` to `'uploaded'`, `onError` flips any still-`'uploading'` to `'error'` with `error.message`, `retryFile` flips an `'error'` back to `'pending'` with `progress: 0, error: undefined`.

`uploadAndGetIds` follows `uploadAndGetPaths` (lines 145-164) exactly, including the part that matters most: **it THROWS when any chip is in error rather than silently dropping it** — the DOR-480 lesson, with the same pluralized message naming the file(s). Already-`'uploaded'` files contribute their ids without re-uploading; only `'pending'` ones go up.

Cancel: an `abortRef = useRef<AbortController | null>(null)` set in the mutation fn, cleared in `onSettled`, and `cancelUpload` calls `abortRef.current?.abort()` — aborting the REQUEST, not just local state (DOR-494). The chip's × cancels the upload while one is in flight and removes the row otherwise; that behavior lives in `Composer.Attachments`, which already implements it — pass `onCancel` and it works.

It calls `transport.uploadRoomAttachments(roomId, rawFiles, onProgress, controller.signal)`. **No `selectedCwd`.** `use-file-upload.ts:18` reads `useAppStore((s) => s.selectedCwd)`; this hook must not, because a room has no cwd and reaching for one is exactly the bug this whole spec exists to avoid.

Store the returned `RoomAttachment` on the `PendingFile`'s `result` slot so `uploadAndGetIds` can read ids back. `PendingFile.result` is typed `UploadResult | undefined` today — widen it, or carry a parallel id map in the hook; prefer widening only if it does not disturb chat's use, and if it does, keep the id map local to this hook and say why in a comment.

**Tests** — `apps/client/src/layers/widgets/room-view/__tests__/use-room-attachments.test.ts`, using `renderHook` with the `TransportProvider` + `QueryClientProvider` wrapper `RoomComposer.test.tsx` builds (lines 65-90) and `createMockTransport` from `@dorkos/test-utils`:

- add / remove / retry / cancel mirror `use-file-upload`'s covered behaviors.
- `uploadAndGetIds` **throws** when any chip is in error. **Mutation evidence required:** changing it to filter failed chips out and return the rest must turn this RED.
- an already-uploaded file is not re-uploaded on a second call.
- two rooms keep separate chip bars — render two hooks with different `roomId` and assert adding to one leaves the other empty.
- cancel aborts the request: assert the `signal` passed to the mocked transport reports `aborted`.

Acceptance: `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/use-room-attachments.test.ts` green; `pnpm --filter @dorkos/client typecheck` and `lint` green (the FSD `no-restricted-imports` rule is error-level and will catch a deep import into `features/composer`).

### Task 4.3: Wire attach into RoomComposer, flip the capability matrix, and prove the resting composer is unchanged

- **Size:** medium · **Priority:** high
- **Depends on:** 4.2 · **Parallel with:** —

`apps/client/src/layers/widgets/room-view/ui/RoomComposer.tsx` (305 lines) already renders `<Composer.Root>` (line 218) and `<Composer.Input>` — VERIFIED, DOR-946 landed. What it does NOT do today is pass `onFilesDropped`, render `Composer.Attachments`, or pass `onAttach`, which is precisely why no dropzone, file input, or overlay mounts (`ComposerRoot` picks `ComposerCard` over `DropCapableCard` when `onFilesDropped` is undefined).

**1. The wiring.**

```tsx
const attachments = useRoomAttachments(room.id);

<Composer.Root onFilesDropped={attachments.addFiles}>
  … the sr-only announcer, unchanged …
  <Composer.OverlayLane> … unchanged … </Composer.OverlayLane>
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

The chip bar goes BETWEEN the overlay lane and the input, matching chat's order in `ChatInputContainer`. Everything else in the file stays exactly where it is: the `role="status"` announcer at lines 220-224 with its comment, the `draftKey` derivation, `useRoomDraft`/`useRoomDraftStore`, `useMentionAutocomplete`, the `focusRequest` effect, `focusOnMount`, `pendingCaret` + its `useLayoutEffect`, and every existing `Composer.Input` prop.

**2. Gating.** `canSubmit` is `{!room.archived}` today (line 284). It becomes `!room.archived && !attachments.hasFailedUpload`, and `canSubmitReason` gains the failed-upload branch in one plain line — archived wins when both apply. Keep the existing archived sentence verbatim: `'This conversation is archived. You can read it, but not add to it.'`

**3. Submit.** `handleSubmit` (lines 193-216) becomes async. Preserve its two hard-won properties exactly: the read-and-clear straight from the store (`useRoomDraftStore.getState().take(draftKey).trim()`) that defeats a second Enter in one tick, and the `newPendingId()` minted at the keystroke. Then:

```ts
const attachmentIds = await attachments.uploadAndGetIds();
```

before the mutate, wrapped so a throw (a failed chip, or an upload that fails during this send) leaves the draft recoverable rather than swallowed — the words must not vanish. Pass `attachmentIds` through to `post.mutate` / `reply.mutate`, which requires extending `PostToRoomInput` (`apps/client/src/layers/entities/room/model/use-post-to-room.ts:37-50`) and `ReplyInThreadInput` (`use-reply-in-thread.ts:39-54`) with `attachmentIds?: string[]`, and threading it into the `transport.postToRoom(roomId, { text, attachmentIds })` / `transport.replyInThread(roomId, { rootEntryId, text, attachmentIds })` calls. Clear the chips on success.

**Nothing about any of this reaches `Composer.Input`** — no attachment state lives inside it — so DOR-948's swap of its internals for Lexical stays a swap. Say so in a comment.

**4. THE CAPABILITY MATRIX — an explicit deliverable, not a footnote.** `apps/client/src/layers/features/composer/index.ts` carries the matrix in its module TSDoc. Two edits, and only two:

- line 33, the Attach row: `| Attach (chip bar, drag, paste) | yes  | reserved         | follows chat |` becomes `| Attach (chip bar, drag, paste) | yes  | yes              | follows chat |`. Keep the column padding so the table stays aligned (Prettier does not format inside a comment).
- lines 40-43, the reserved note, currently:

  > `"reserved" means the slot exists and is intentionally unwired: room attach lands in DOR-947, and room slash commands are deferred to a follow-up — a room has no single cwd, session, or runtime, so \`transport.getCommands\` has nothing to key on.`

  drops its attachment half and keeps the slash-command half:

  > `"reserved" means the slot exists and is intentionally unwired: room slash commands are deferred to a follow-up — a room has no single cwd, session, or runtime, so \`transport.getCommands\` has nothing to key on.`

Leaving the cell at "reserved" once rooms compose attach would be exactly the parallel declaration this slice's doctrine forbids — the matrix must agree with what is on screen, because that is the only reason it is allowed to exist.

**5. Tests.** Update `apps/client/src/layers/widgets/room-view/__tests__/RoomComposer.test.tsx`. Every existing behavioral assertion must pass with NO change to what it asserts — draft persistence across remount, thread vs room draft keys never sharing text, the mention picker on `@`, the empty-picker `role="status"` announcement, Escape dismissing, double-Escape clearing, the archived reason line, Enter posting with a minted `clientId`, the second-Enter-in-one-tick guard. Add:

- the composer now mounts the dropzone — a file input and `role="presentation"` appear. This is the POSITIVE counterpart of the DOR-946 assertion in `RoomComposer-chrome-delta.test.tsx` that it did NOT; find that assertion and update it in the same commit rather than leaving two files disagreeing.
- the attach handler is wired to BOTH `onAttach` and `onFilesDropped`.
- Enter with a chip in error does not post, and the reason line explains why.

**6. The discriminating proof: an EMPTY DOM diff for the resting composer.** The harness already exists — `apps/client/src/test-helpers/dom-parity.ts` (`serializeDom`, `matchDomBaseline`), with committed baselines under `apps/client/src/layers/widgets/room-view/__tests__/__baselines__/` including `room-composer.idle`, `room-composer.archived`, `room-composer.mention-open`, consumed by `RoomComposer-chrome-delta.test.tsx:215` as `matchDomBaseline(import.meta.url, 'room-composer.idle', serializeDom(container))`. Do NOT build a new harness.
With **no files pending**, `room-composer.idle` must diff EMPTY against its existing committed baseline. Attach is additive; a person who never touches a file must see the composer they had yesterday. This is the check that fails on any stray wrapper, class, or spacing the wiring introduces — and note that `ComposerRoot` swapping `ComposerCard` for `DropCapableCard` legitimately adds the hidden `<input type="file">` node, so if the diff is non-empty, decide deliberately whether that node is the whole of it and re-baseline with the diff attached as evidence, or fix the wiring. Never re-baseline silently.

**VERIFICATION GOTCHA:** a bare `pnpm vitest run` from the repo root falsely fails `RoomComposer.test.tsx`. Re-run from `apps/client` before believing a red: `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/`.

Acceptance: `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/` green; `pnpm --filter @dorkos/client typecheck` and `lint` green; `grep -n 'reserved' apps/client/src/layers/features/composer/index.ts` shows the note naming only slash commands.

### Task 4.4: Render attachments in the timeline — thumbnails for verified images, chips for everything else

- **Size:** medium · **Priority:** high
- **Depends on:** 3.4 · **Parallel with:** 4.1, 4.2

New file `apps/client/src/layers/widgets/room-view/ui/RoomEntryAttachments.tsx`, beside the already-split `RoomEntryBody`. It is its own module per the design record's instruction that attachment rendering must not grow `RoomEntryRow` back.

**The slot.** `RoomEntryRow.tsx` renders, inside `<div className={styles.body()}>` (opened line 260): the author line (261-273), the orphaned-reply notice (274-278), `<RoomEntryBody … className={styles.content()} />` (279-286), `<EntryReactionRow … />` (290-299), `<RoomEntryActions … />` (300-306). The attachments block goes **between line 286 and line 290** — directly under the message body, above the reaction pills, inside the content column.

**The component:**

```tsx
interface RoomEntryAttachmentsProps {
  attachments: RoomAttachment[];
}
```

- `preview === 'image'` → an inline thumbnail: `<img>` with `className="max-h-64 max-w-full rounded-md border"`, `loading="lazy"`, `alt={attachment.name}`, inside a link to `attachment.url` that opens the file.
- everything else → a compact chip: a file icon (`lucide-react`), the name, and a human-readable size, as a download link.
- several attachments wrap in a `flex flex-wrap gap-2` row under the body.
- rendered from `entry.attachments ?? []`, so an entry predating the field renders nothing at all — no rail, no ghost, the way `EntryReactionRow` renders nothing for an entry with no reactions.
- **Accessibility:** the block is included in the row's described content so a screen reader hears "2 files: screenshot.png, notes.pdf" rather than nothing. `RoomEntryRow` already threads `contentId` and a hidden `summary`/`summaryId` into `RoomEntryBody` — read how that works and extend the same summary rather than adding a second `aria-describedby`.
- Never hand-sort Tailwind classes; Prettier's class sorter owns them.

**The safety property, and it is the whole point:** the decision to render an `<img>` comes from `preview`, **never** from `mimeType`. `preview` is non-null only when the server verified the BYTES; `mimeType` for a non-image is whatever the uploader declared. A renderer that trusted `mimeType` would put an attacker-chosen string into an `<img src>` decision on the cockpit's own origin.

**Tests** — `apps/client/src/layers/widgets/room-view/__tests__/RoomEntryAttachments.test.tsx`:

- `preview: 'image'` renders an `<img>` whose `alt` is the attachment name and whose link points at `url`.
- `preview: null` renders a download chip and **no** `<img>`. **Mutation evidence required:** rendering the thumbnail from `mimeType.startsWith('image/')` instead of from `preview` must turn this RED — construct the fixture as `{ preview: null, mimeType: 'image/png' }`, which is exactly the GIF-bytes-in-a-`.png` case the server produces, so the two layers' tests describe the same attack.
- an entry with `attachments: undefined` and one with `attachments: []` both render nothing.
- several attachments render in array order.
  And in `RoomEntryRow.test.tsx`: an entry with attachments renders the block between the body and the reaction row (assert with `compareDocumentPosition`, not by index), and an entry without one is byte-identical to what it renders today.

**VERIFICATION GOTCHA:** run room-view suites from `apps/client`, not the repo root — `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/`.

Acceptance: those suites green; `pnpm --filter @dorkos/client typecheck` and `lint` green; the mutation witnessed red and restored.

### Task 4.5: Carry attachment names on the pending row so files do not vanish between send and echo

- **Size:** small · **Priority:** medium
- **Depends on:** 4.3 · **Parallel with:** 4.4

Without this, a person who attaches three files watches them disappear from the chip bar on Enter and not reappear until the room echoes the real entry back. The words survive that gap today; the files must too.

**1. `PendingPost` gains a field.** `apps/client/src/layers/entities/room/model/pending-posts.ts`, the interface at lines 59-87. Add after `text`:

```ts
  /**
   * The names of the files sent with this message, in the order they will
   * render. Empty for a message with none.
   *
   * NAMES and not refs: the row exists precisely because the entry does not yet,
   * so there is nothing to link to and nothing to draw a thumbnail from. What a
   * person needs to see is that their files are still in the message.
   */
  attachmentNames: string[];
```

Default it to `[]` everywhere a `PendingPost` is created — the `start` action in `usePendingPostStore` (the store is at lines 162-248) — so no existing caller breaks and an absent value is never `undefined`.

**2. Thread it through the mutations.** `usePostToRoom`'s `onMutate` calls `usePendingPostStore.getState().start({ clientId, roomId, threadRootId: null, text })` (`use-post-to-room.ts:99-117`); `useReplyInThread` does the same with a `threadRootId` (`use-reply-in-thread.ts:72-84`). Both inputs gained `attachmentIds` in task 4.3; add `attachmentNames?: string[]` alongside and pass it into `start`. The composer supplies it from `attachments.pendingFiles.map((f) => f.file.name)` captured BEFORE the upload, so the names are right even if the upload is still in flight.
On retry, `RoomPendingRow.retry` re-sends from the stored post (`{ clientId, roomId, threadRootId, text }`, lines ~47-58) — it does NOT re-send attachments, and it must not pretend to. Decide and document the honest behavior: a failed send whose attachments were already uploaded can retry with the same ids if the post carries them, or the retry drops the files and the row says so. Prefer carrying the ids on `PendingPost` so retry is whole; if that is more than this slice should take, make the row's failed-state sentence say the files need re-attaching, and file the follow-up. Do not leave it silent.

**3. The row.** `RoomPendingRow.tsx` renders only `post.text` in a `<p>` today. Add the names below it as inert chips — no thumbnail, no link, muted like the rest of a pending row — reusing the chip's visual language from `RoomEntryAttachments` without reusing a link. `RoomPendingList` needs no change.

**Tests** — `apps/client/src/layers/widgets/room-view/__tests__/RoomPendingRow.test.tsx` (it exists):

- a pending post with two names renders both, inert: assert no `<a href>` and no `<img>` inside the row.
- a pending post with `attachmentNames: []` renders exactly what it renders today — add this as the no-regression pin.
- the failed state still shows "Try again" / "Discard" and whatever the retry sentence became.
  And in `RoomComposer.test.tsx`: sending with two files puts both names on the pending row before the echo arrives.

Run from `apps/client`: `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/`.

Acceptance: those suites green; `pnpm --filter @dorkos/client typecheck` and `lint` green; the retry behavior is documented in the row's TSDoc rather than implied.

### Task 4.6: Close the documentation loop — playground, docs, changelog, project structure

- **Size:** medium · **Priority:** medium
- **Depends on:** 4.4, 4.5 · **Parallel with:** 4.7

Everything the feature touches outside the code that runs it.

**Dev playground** (per the `maintaining-dev-playground` skill). Room showcases live in `apps/client/src/dev/showcases/RoomsShowcases.tsx` / `RoomDeliveryShowcases.tsx` with data in `rooms-showcase-data.ts`, and the registry is `apps/client/src/dev/sections/rooms-sections.ts` (which exports `ROOMS_SECTIONS: PlaygroundSection[]`, 14 entries today, none for the composer). Add a `RoomEntryAttachments` showcase covering: one image, one non-image, and several together. Register it with the entry shape used verbatim by the neighbouring `RoomPendingRow` entry (rooms-sections.ts:168-174):

```ts
{
  id: 'roomentryattachments',
  title: 'RoomEntryAttachments',
  page: 'rooms',
  category: 'Delivery',
  keywords: ['attachment', 'file', 'image', 'thumbnail', 'download', 'chip', 'upload'],
},
```

**The id must equal `slugify(title)`** — that module's header says so and the playground-registry test suite verifies it. Run the playground registry tests and `apps/client/src/dev/__tests__/PlaygroundSearch.test.tsx` after adding.

**User docs.** `docs/concepts/rooms.mdx` (302 lines) is the rooms guide. Add one short section in the `writing-for-humans` register — plain enough for a smart 9th grader who does not code — saying what you can attach, that only the people and agents in that room can read it, and that agents get it automatically with the message. Place it near `## What you see while an agent works` / `## Good to know` rather than in `## Reference (for developers)`. Do NOT claim rich text; that is DOR-948 and it has not shipped.
Also update `docs/getting-started/configuration.mdx:540`, which currently reads "Uploaded files (from chat, workbench, or anywhere else you attach a file) are stored under `.dork/.temp/uploads/` in your working directory" — that is now only half true. Say plainly that room attachments are stored per install rather than per project, and that the same `uploads.maxFileSize` / `uploads.maxFiles` / `uploads.allowedTypes` limits below it apply to both.

**Changelog fragment.** Mint an id with `.claude/scripts/id.ts` and create `changelog/unreleased/<id>-room-attachments.md`. User-facing prose at the `writing-for-humans` bar — say what a person sees, not how it works:

- you can now attach files in rooms and threads — click the paperclip, drag a file onto the box, or paste one;
- images show in the conversation, everything else shows as a chip you can download;
- only the people and agents in that room can open them;
- agents in the room get the files with your message, with nothing to approve.
  Do NOT claim rich text, and do NOT describe the storage layout or the projection — neither is something a person sees. Keep it short.

**`contributing/project-structure.md`** — the server section starts at line 259 with the tree at 264 and `├── services/` at 285. Add the `services/rooms/attachments/` entry with a one-line description in the style of its neighbours. Do not pad the file with anything else.

**TSDoc audit** for the whole feature: module docs on the new store, the projector, the client hook, and `RoomEntryAttachments`; and confirm task 4.3's capability-matrix edit landed (`grep -n 'reserved' apps/client/src/layers/features/composer/index.ts` must show the note naming only slash commands).

Acceptance: `cd apps/client && pnpm vitest run src/dev` green; `pnpm --filter @dorkos/client lint` green; the changelog fragment exists and `fragment-present` will find it; `/docs:coverage` (or the equivalent check) reports no untracked new docs file.

### Task 4.7: Add the room-attachments browser test — attach, send, and see it from a second reader

- **Size:** medium · **Priority:** medium
- **Depends on:** 4.4, 4.5 · **Parallel with:** 4.6

**DRIFT NOTE:** the spec says "the fifteen existing ones run unmodified". VERIFIED: `apps/e2e/tests/rooms/` holds **11** `.spec.ts` files (`direct-messages`, `mention-picker`, `room-conversation`, `room-entry-actions`, `room-identity`, `room-presence-sidebar`, `room-presence`, `room-reactions`, `room-sheet-phone`, `room-sheet`, `rooms-in-palette`) plus three helper modules (`open-cockpit.ts`, `room-sheet-helpers.ts`, `room-signals.ts`). Eleven, not fifteen. They all run unmodified either way — a spec that needs editing means behavior moved, not that the spec is stale.

**SECOND DRIFT, and it shapes the work: `grep -rn 'setInputFiles' apps/e2e` returns NOTHING.** There is no file-input coverage anywhere in this suite today, for chat or anything else. This is the first, so budget for establishing the pattern rather than following one, and read the `browser-testing` skill before starting.

New spec `apps/e2e/tests/rooms/room-attachments.spec.ts`, against the mock runtime, following `room-conversation.spec.ts`'s structure. The page object is `apps/e2e/pages/RoomsPage.ts`, whose `composer(spokenName)` resolves `getByRole('combobox', { name: \`Message ${spokenName}…\` })`and whose`post(spokenName, text)`fills and presses Enter (lines 298-312). Add an`attach(spokenName, filePaths)`method there rather than reaching for a raw locator in the spec — the file input is`Composer.Input`'s hidden `<input type="file" multiple>`, next to the button whose accessible name is `Attach file`.

The test, one flow:

1. create a channel from the sidebar (reuse the existing helper), open it;
2. `setInputFiles` with two fixtures — a real small PNG and a `.log` or `.pdf` — committed under an `apps/e2e/fixtures/` path (check whether one exists before creating it);
3. assert two chips appear above the box with the two filenames;
4. type a message and press Enter;
5. assert the entry lands (wait on the server round trip the way `room-conversation.spec.ts:78-84` does — nothing is drawn until the server's copy arrives on the room's stream, so this asserts the round trip and not an optimistic echo), and that the row shows an image thumbnail for the PNG and a download chip for the other;
6. assert the composer's chip bar is empty again and the box is cleared.

Then the two proofs that matter more than the happy path:

- **A second reader sees both.** No room spec opens a second browser context today; the only precedent anywhere is `apps/e2e/tests/streams/multi-window.spec.ts:156` (`await browser.newContext()`). Follow it: open a second context in the same room and assert both attachments render there too. If a second context cannot be made a member with the existing helpers inside a reasonable budget, drop this half and say so explicitly in the work item rather than weakening it into an assertion that cannot fail.
- **The refusal.** A context that is not a member fetching the attachment URL directly gets a 404. `page.request.get(url)` is enough; it does not need a rendered page.

Do NOT test the agent projection here — it needs a real model turn. That is asserted at the unit level over a real temp filesystem (task 3.3), which is where its failure modes actually live.

Acceptance: the new spec passes; all 11 existing room specs pass UNMODIFIED (`git diff --stat apps/e2e/tests/rooms/` shows only the new file plus the `RoomsPage.ts` addition and any fixture); the spec fails when the attach wiring is reverted — run it that way once and record the failure, because a browser test that passes against a composer with no file input is a test of nothing.

### Task 4.8: Full-repo gate and pre-PR adversarial review

- **Size:** small · **Priority:** high
- **Depends on:** 4.6, 4.7 · **Parallel with:** —

The last gate. Everything is on screen now; this proves the whole repo is still green and the feature is honestly described.

Run, in this order, from the worktree root:

1. `pnpm --filter @dorkos/shared build` — stale dists are the classic false red.
2. `pnpm --filter @dorkos/shared typecheck` · `pnpm --filter @dorkos/db typecheck` · `pnpm --filter @dorkos/server typecheck` · `pnpm --filter @dorkos/client typecheck` — green.
3. `pnpm --filter @dorkos/server lint` · `pnpm --filter @dorkos/client lint` · `pnpm --filter @dorkos/db lint` — green.
4. `pnpm test -- --run` — the full suite through turbo. **Never a bare `pnpm vitest run` for a full run** — it skips the per-package env turbo sets up and has falsely failed tests in dev.
5. `cd apps/client && pnpm vitest run src/layers/widgets/room-view/__tests__/` — the room-view suites re-run from `apps/client`, because a bare root run falsely fails `RoomComposer.test.tsx`.
6. `pnpm --filter @dorkos/db run db:check` — migrations still current.
7. `pnpm docs:export-api` — re-run and confirm `git diff docs/api/` is EMPTY, proving task 2.4's regeneration is still fresh after every later change.
8. `pnpm build` — all apps build.
9. `pnpm knip` (after the build, so dists exist) — no orphaned export left behind by the four phases.
10. `pnpm verify` — the affected-only loop-closer.

Final sweeps, all as described:

- Hard rule 3: `grep -rn 'os.homedir' apps/server/src` returns only the three carve-outs enumerated in `.claude/rules/dork-home.md` (`lib/dork-home.ts`, `lib/boundary.ts`, `claude-code/claude-config-dir.ts`) plus tests.
- Hard rule 2: no runtime SDK import outside its adapter directory. The projector must import none — that is what makes ADR 260807-233816's "works identically on claude-code, codex, and opencode" true.
- Hard rule 1: `pnpm --filter @dorkos/client lint` reports no `no-restricted-imports` violation; no deep import into `features/composer` from the room-view widget (`vi.importActual` in a test is the sanctioned escape and the only one).
- Hard rule 4: no `jsdoc` error anywhere.
- The capability matrix agrees with the screen: `apps/client/src/layers/features/composer/index.ts`'s Attach row reads `yes` for Room and the reserved note names only slash commands.
- Chat is untouched: `git diff --stat <base> -- apps/client/src/layers/features/chat apps/server/src/routes/uploads.ts apps/server/src/services/core/upload-handler.ts` shows nothing beyond task 4.1's generalization of `uploadFilesOverHttp` and the sniffer re-export from task 1.3. Anything else means the non-goal was broken.
- The changelog fragment exists and claims nothing unverified — no rich text, no editing or deleting a posted file, no retention or quota behavior.

**Then, before any PR opens, put the branch through an independent adversarial review against `REVIEW.md`.** Point the reviewer at the two things most likely to be wrong, because they are the two things this decomposition changed relative to the spec: (a) the `bind` hook on `appendEntry` and whether the FK really is checked immediately — the reviewer should re-run the red case, not take the note's word for it; and (b) the changed return type of `buildRoomContext` and whether the projection plan and the rendered context can still drift apart. Also ask them to check the orchestrator's claims, not only the code.

Acceptance: every command green, every sweep as described, the adversarial review complete and its findings addressed or explicitly deferred with a reason.
