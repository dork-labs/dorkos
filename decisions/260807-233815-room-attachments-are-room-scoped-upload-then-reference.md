---
id: 260807-233815
title: Room attachments are room-scoped, upload-then-reference, stored under dorkHome behind a store seam
status: accepted
created: 2026-08-07
spec: room-attachments
superseded-by: null
---

# 260807-233815. Room attachments are room-scoped, upload-then-reference, stored under `dorkHome` behind a store seam

## Status

Accepted — verified against `main` on 2026-08-30. `room_attachments` is a real table
(`packages/db/src/schema/rooms.ts`), `POST /:id/attachments` and
`GET /:id/attachments/:attachmentId` are routed (`apps/server/src/routes/rooms.ts`), the
`RoomAttachmentStore` seam and its `<dorkHome>/rooms/<roomId>/attachments/` local
implementation exist (`apps/server/src/services/rooms/attachments/`), and the inline-vs-download
split ships with `nosniff`. One mechanism named below turned out differently — see the amendment.

## Context

Chat uploads a file to `{cwd}/.dork/.temp/uploads/` through `POST /api/uploads?cwd=…`, then folds the
resulting path into the message text (ADR-0100). Neither half transfers to a room. A room has no
`cwd` — it has agent members with several different working directories and human members with none —
and the chat route's access model is "anyone who can name the directory", which is not a room's
membership. The message half is worse: a room turn's prompt is the message byte for byte
(`.claude/rules/room-conduct.md`, ADR-0273), and mention spans are UTF-16 offsets into the raw body,
so a prefix would re-point every pill in the entry. Meanwhile the profile-photo work (ADR
260806-222546, shipped as DOR-976) established the pattern for a per-install, durable file: bytes
under `<dorkHome>`, reached through a store interface whose `put` returns the URL, so a future
remote store changes no route, schema, or renderer.

## Decision

Room attachments are **uploaded first and referenced second**. `POST /api/rooms/:id/attachments`
takes multipart bytes from a person who is a member of that room, sniffs them, and writes both a row
in a new `room_attachments` table and a file at
`<dorkHome>/rooms/<roomId>/attachments/<attachmentId>.<ext>` — via `resolveDorkHome()`, never
`os.homedir()`, and never the per-project uploads directory. The write goes through a
`RoomAttachmentStore` interface whose `put` returns the URL the client fetches and whose `localPath`
answers `null` when the bytes are not on this machine. The post that follows carries only
`attachmentIds`; the server resolves them, refuses any that are not this caller's, not this room's,
or already posted, and **binds them to the entry inside the entry's own transaction** through
`writePost`'s existing `within(tx)` hook. Attachments then reach readers the way reactions do — their
own table, rolled up onto the entry in one indexed query per page — so `room_entries` gains no
column and `body.text` is never rewritten. Serving is membership-scoped and, because a room accepts
every mime type by default, **only magic-byte-verified PNG/JPEG/WebP is served inline**; everything
else is `application/octet-stream` with `Content-Disposition: attachment` and `nosniff`.

## Consequences

### Positive

- One place a room's files live, independent of any agent's working directory, so the ADR-0100
  negative that motivated this ("if the agent's cwd differs from the upload cwd, relative paths may
  not resolve correctly") cannot recur.
- Access finally matches the thing being protected: a room's files are readable by the room, not by
  whoever can name a path.
- The seam is testable rather than aspirational — a fake store answering an absolute `https://` URL
  proves the sync-readiness claim, exactly as `profile-avatar.test.ts` proves it for photos.
- Mention spans, the cascade guard, and the byte-for-byte prompt are all untouched, because an
  attachment is a field beside the body and never a change to it.
- An entry that claims files nothing points at is impossible: the bind shares the entry's
  transaction.
- The inline/download split makes an uploaded `.html` or SVG a download rather than a document
  executing on the cockpit's own origin.

### Negative

- A second upload path exists beside chat's, and the two now differ in storage, access model, and how
  the file reaches the agent. Someone reading only one of them will guess wrong about the other.
- An upload that is never posted leaves an unbound row and a file on disk. The window is small (the
  composer uploads on submit) but real, and a sweep is needed rather than being free.
- Files are only as portable as the machine they were uploaded to until a remote store exists —
  moving installs loses them, the same trade the profile photo accepted.
- Nothing re-encodes, resizes, or expires a posted file, so a room's directory grows monotonically
  with what people put in it.
- The `CommunityAdapter` port stays text-only, so `local-projection.ts` drops attachments — a known,
  documented gap rather than a silently lossy mapping.

## Amendment — 2026-08-30: the bind runs through its own hook, not through `within(tx)`

**What changed.** The decision above says the attachments are bound to the entry "inside the entry's
own transaction through `writePost`'s existing `within(tx)` hook". They are not: `appendEntry` gained
a **second** hook, `bind(tx, seq)`, and the attachment UPDATE runs there.

**Why the named hook could not work.** `within` runs BEFORE the entry row is inserted, and
`room_attachments` carries a foreign key pointing AT the entry. With `foreign_keys` ON and no
`DEFERRABLE` clause emitted by drizzle, the key is checked at statement time, so the UPDATE in
`within` fails immediately with `FOREIGN KEY constraint failed`. `bind` is its mirror: same
transaction, but after the insert, so the child row has a parent to point at. Pinned by
`room-store-bind-hook.test.ts`, which asserts both halves — `within` is refused, `bind` is accepted,
and a throwing `bind` rolls the entry back.

**What is unchanged.** The property the decision was making — an entry can never claim files nothing
points at, because both writes share one transaction — holds exactly as stated. Only the name of the
hook was wrong. `within` still exists and still runs first, for the bridged-roster join it was built
for.
