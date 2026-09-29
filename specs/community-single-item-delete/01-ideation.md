---
slug: community-single-item-delete
number: 260923-214410
created: 2026-09-23
status: ideation
linear-issue: DOR-2282
project: Cloud-Hosted Communities
---

# Delete one message or one file in a Community

**Slug:** community-single-item-delete
**Author:** Claude (for DOR-2282)
**Date:** 2026-09-23

---

## 1) Intent & Assumptions

- **Task brief:** Owners and admins (and authors) delete a single message or file. Tombstone text, audit, storage freed at once, propagation via the redaction feed. There is no edit history to purge.
- **Source material:** `specs/community-member-erasure/02-specification.md` (tombstones in place, `entry_redactions`, the content version, the redaction feed in task 2.1) and its code on `origin/flow/dor-2265-member-erasure` (#2029, migration 0013), which is not on `main` yet. The erasure spec listed "deleting or editing single messages, for moderation or otherwise" as a non-goal; this spec is that follow-up.
- **Assumptions:**
  - Entries are immutable today: there is no edit route and no revision table, so a delete has only the current row to change.
  - The public wire is strict (`CommunityWireEntrySchema` is a `z.strictObject`) and parsed by DorkOS installations that update on their own schedule. A deleted message must be an ordinary entry with different text, as erasure's tombstone is. No new field and no new stream event.
  - The member erasure code (#2029) lands first. It provides `entry_redactions`, `community_content_versions`, the blob-cleanup statements, and the tombstone payload hash this spec reuses.
  - The operator pre-authorized decisions in this programme.
- **Out of scope:**
  - Editing messages.
  - Host authority deleting content. That is the takedown in `specs/community-host-takedown/`, which reuses this spec's machinery.
  - A delete action inside the DorkOS app's room view (the server route is ready for it; the DorkOS UI is a follow-up).
  - Recalling copies outside the Community server beyond what the redaction feed reaches.

## 2) Pre-reading Log

- `apps/community/src/erasure.ts` (#2029): `tombstone()` rewrites `text`, `author_display_name`, `idempotency_key`, `payload_hash`, sets `erased_at`, deletes `entry_mentions`, inserts `entry_redactions`, bumps the content version, in batches locked `FOR NO KEY UPDATE` because a reply holds `FOR KEY SHARE` on its parent while holding its channel. `queueBlobs()` moves blobs to `pending_delete` and inserts `pending_blob_deletions` in the same transaction. `tombstonePayloadHash(parent)` hashes the tombstone in the post payload shape.
- `apps/community/migrations/0013_member_erasure.sql` (#2029): `entry_redactions(id identity, community_id, channel_id, entry_id, created_at)` with a deferred channel foreign key; `community_content_versions`; `entries.erased_at`; the partial unique index `entries_author_key_unique` that makes an in-place key rewrite safe.
- `apps/community/src/routes/entries.ts`: the post route replays by `(author, channel, idempotency_key)` and answers `409 IDEMPOTENCY_CONFLICT` when the stored `payload_hash` differs.
- `apps/community/src/routes/attachments.ts`: upload and `GET /attachments/:id` only. No delete route. An unbound upload (no `entry_id`) exists until a post binds it.
- `apps/community/src/routes/members.ts`: the rank rule for removal: nobody removes the owner; only the owner removes an admin.
- `apps/community/src/routes/exports.ts`: an export commit refuses with `409` when the content version moved since its snapshot.
- Host-operator P2 (`specs/community-host-operator-api/`): counted storage excludes `pending_delete` bytes, so moving a blob to `pending_delete` frees space at once.
- Erasure task 2.1: `GET …/channels/:id/redactions` returns the current projection of every entry with an `entry_redactions` row, and DorkOS mirrors rewrite their cached copies from it.

## 3) Codebase Map

- **Primary components:** new `src/content-removal.ts` (shared with erasure and the host takedown), new routes in `routes/entries.ts` and `routes/attachments.ts`, `data.ts` (a removal authority check), `schema.ts` + one migration.
- **Shared dependencies:** `erasure.ts` helpers moved into `content-removal.ts`; `storage/managed-blobs.ts`; the tenant `audit_events` table.
- **Data flow:** `DELETE /entries/:id` → lock community `FOR SHARE` → lock entry `FOR NO KEY UPDATE` → authorize against the author → rewrite text, clear mentions and files, queue blobs, redaction row, content version, audit → return the tombstone entry. DorkOS mirrors pick it up from the redaction feed.
- **Blast radius:** entries and attachments of one community; the export commit check (a delete during an export makes it retry); the Community browser's message and file menus.

## 5) Research

- **Hard delete the row.** Breaks threads (replies point at it), sequence numbers, cursors, and unread counts; the strict wire has no way to say "gone". Rejected.
- **Hide with a flag and filter everywhere.** Every read path (history, threads, stream, exports, feed, search in DorkOS) must remember the filter; one miss leaks deleted text. Rejected.
- **Tombstone in place (recommended).** The erasure pattern: the row keeps its id, sequence, and thread links; its text becomes a fixed sentence; files and mentions go; a redaction row tells caches. Every read path is correct by construction.

## 6) Decisions

| #   | Decision                           | Choice                                                                                                                                                                                                                        | Rationale                                                                                                                             |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What a deleted message shows       | Same row, text replaced: `This message was deleted.` (author), `This message was removed by a community admin.` (owner or admin), `This message was removed by the host.` (takedown); author name kept; no mentions; no files | Threads and cursors keep working; the strict wire is unchanged; saying who removed it is honest without naming the person             |
| 2   | Who deletes what                   | Author: own messages and files, and those of agents they own. An agent: its own. Owner: anything. Admin: anything except messages by the owner or an active admin                                                             | Mirrors the member-removal rank rule already in `members.ts`                                                                          |
| 3   | Grace period or undo               | None. Immediate; the UI confirms first                                                                                                                                                                                        | Brief: storage freed at once. Nothing edits, so nothing to restore                                                                    |
| 4   | Deleting one file                  | Removes the file and its bytes; the message keeps its text. If that leaves a message with no text and no files, the message becomes the tombstone                                                                             | No wire field can mark "a file was removed"; a bubble with nothing in it is worse than a tombstone                                    |
| 5   | Retrying the original post         | The row keeps its `idempotency_key`; a retry with that key returns the tombstone (`200`, repeated), never a new message; `payload_hash` becomes the tombstone hash                                                            | A lost response must never recreate deleted content; no hash of deleted text stays                                                    |
| 6   | Exports                            | Bump the content version (an export in progress retries or rebuilds); finished exports stay until they expire                                                                                                                 | Deleting a finished owner export because someone removed a typo is hostile; the takedown spec, not this one, deletes finished exports |
| 7   | Lifecycles                         | Allowed in `active`, `archived`, and `held`; refused while `suspended` or `deletion_pending`                                                                                                                                  | Removal is not growth (the erasure rule)                                                                                              |
| 8   | Credentials                        | A browser session, a grant that can post (not `history_only`), or an agent credential                                                                                                                                         | The same credentials that could have posted it                                                                                        |
| 9   | Propagation                        | One `entry_redactions` row per changed entry; the redaction feed (erasure task 2.1) carries it to DorkOS mirrors; the Community browser polls the feed while a channel is open                                                | Reuse, no new event type (strict parsers)                                                                                             |
| 10  | Shared machinery with the takedown | This spec lands first and creates `src/content-removal.ts` (tombstone, file removal, blob queue, redaction row, content version); erasure is refactored onto it; the takedown calls it with `removedBy: 'host'`               | One implementation of "remove content in place"                                                                                       |
