---
slug: room-attachments
number: 260806-215028
created: 2026-08-06
status: ideation
---

# File attachments in rooms

**Slug:** room-attachments
**Author:** flow agent (IDEATE stage, DOR-947)
**Date:** 2026-08-06
**Tracker:** DOR-947 · project "Rooms, Channels & Threads" · umbrella DOR-951

---

## 1) Intent & Assumptions

- **Task brief:** Let people add files into the room composer and post them to the room. Today attachments are chat-only and are folded into the prompt text; rooms have none. Needs a room upload path, a first-class attachment field on room entries, and timeline rendering.
- **Assumptions:**
  - "First-class" means attachments ride the entry as structured data (ids/URLs + metadata), not text smuggled into the body — unlike chat, where files become "Please read the following uploaded file(s):" prompt text.
  - Room entries are read by agents as well as people, so an attachment must be _consumable by an agent turn_ (a real path/URL an agent can open), not only renderable.
  - The composer affordance lands wherever the DOR-946 parity session puts the attach slot — this spec should not invent a second placement.
- **Out of scope:**
  - Rich text (DOR-948); composer shell itself (DOR-946).
  - Retrofitting chat's fold-into-prompt behavior — chat stays as-is here.
  - Mention addressing (`mentions.ts` untouchable); attachment text must never affect mention spans' raw-text offsets — attachments are additive fields, never body rewrites.

## 2) Pre-reading Log

- Memory `project_composer_rooms_unification_design`: "Attachments are chat-only and folded into prompt text. Rooms have zero attachment capability." Sequencing locked: files-in-rooms comes after identity (shipped), before rich text.
- `apps/server/src/routes/uploads.ts`: an upload path already exists — `POST /api/uploads` + `GET /api/uploads/:filename`. Candidate for reuse or extension.
- `packages/shared/src/room-schemas.ts`: **no attachment/files field on `RoomEntry` today** (verified 2026-08-06) — the schema gap is real.
- `apps/client/src/layers/features/chat/ui/input/FileChipBar.tsx`, `use-drag-and-paste.ts`: the chat composer's attachment UX (chips above the input, drag + paste capture).
- `apps/client/src/layers/features/chat/ui/message/FileAttachmentList.tsx`: chat's render side for attachments.

## 3) Codebase Map

- **Server:** `services/rooms/` (RoomService `post()` path), `routes/rooms.ts` `POST /:id/entries` (202 trigger-only; entries ride SSE), `routes/uploads.ts`. New: attachment field on the entry write path + persistence (`packages/db` migration — next after `0050_shiny_richard_fisk.sql`).
- **Shared:** `room-schemas.ts` `RoomEntrySchema` + `PostToRoomRequestSchema` gain an attachments shape (Zod, versioned).
- **Client:** room composer (attach affordance per DOR-946), `widgets/room-view` timeline (`RoomEntryRow` — being split under DOR-956; attachment rendering should land as its own module, not grow the row file back).
- **Blast radius:** room entry wire shape (SSE events, hydration), DB schema, e2e room specs, `CommunityAdapter` conformance (`communityConformance`) if the entry shape is part of the port contract — check during SPECIFY.

## 5) Research — options

1. **Reuse `/api/uploads` + attach by reference** — upload first, then `POST /:id/entries` carries `attachments: [{id/url, name, mimeType, size}]`. Pros: storage path exists; entry stays small; agent-consumable URL. Cons: orphaned uploads need a lifecycle story (entry never posted).
2. **Room-scoped upload endpoint** (`POST /api/rooms/:id/attachments`) with room-scoped storage + membership-scoped reads. Pros: access control matches room membership (uploads route is currently unscoped); tidy per-room lifecycle. Cons: new surface; more work.
3. **Inline base64 on the entry.** Rejected: bloats SSE frames and transcripts; breaks the small-entry invariant.

**Recommendation:** Option 2's access model with Option 1's flow (upload-then-reference), i.e. room-scoped upload + reference on the entry — but confirm the access-control requirement during SPECIFY (is room membership the read gate for attachments?).

## 6) Decisions

No decisions made here — **parked on the /visual-companion design session with the operator.** Open design questions:

| #   | Design question                                                                                                         | What hangs on it                 |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | Composer affordance: chip bar parity with chat, or a room-specific treatment? (Coupled to DOR-946's capability matrix.) | Composer half of the build       |
| 2   | Timeline rendering: inline image previews vs uniform file chips; grouping when one entry has several files?             | `RoomEntryRow` attachment module |
| 3   | Do agents receive attachments as paths in their room context automatically, or only on request?                         | Server context-assembly behavior |
| 4   | Limits and types: max size, count per entry, any type restrictions?                                                     | Upload validation                |

**Next step:** design session with the operator → record decisions → SPECIFY (schema + migration + access model are spec-level work).
