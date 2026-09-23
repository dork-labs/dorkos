---
slug: community-single-item-delete
number: 260923-214410
created: 2026-09-23
status: specified
linear-issue: DOR-2282
project: Cloud-Hosted Communities
---

# Delete one message or one file in a Community

**Status:** Approved (decisions pre-authorized by the operator for this programme)
**Author:** Claude (for DOR-2282)
**Date:** 2026-09-23

## Overview

A person can delete a message or file they posted, and a community's owner and admins can remove anyone's (within the usual rank rule). The message stays in its place in the conversation with its text replaced by one fixed sentence, so replies, threads, and read positions keep working. Its files and their bytes go at once, freeing storage. Each deletion is audited and recorded in the redaction feed, so DorkOS installations replace their cached copies.

This spec also creates the shared "remove content in place" module that member erasure is refactored onto and that the host takedown (`specs/community-host-takedown/`) calls. It therefore lands before the takedown.

## Background / Problem Statement

- Entries are immutable. There is no route that deletes or edits a message or a file (`routes/entries.ts`, `routes/attachments.ts`). A person who posts something by mistake, or a moderator faced with a harmful post, can only remove the whole member.
- There is no edit history: entries have no revision table, so a delete has only the current row to change.
- Member erasure (`specs/community-member-erasure/`, #2029) already built the pieces: a tombstone rewrite that keeps thread shape, `entry_redactions` rows for caches, a content version that stops an export snapshotted before a change from committing after it, and blob cleanup inside the removing transaction. They are private to `erasure.ts` today.
- Storage limits (host-operator P2) count only `stored` and `committed` blobs, so moving a blob to `pending_delete` frees space immediately.

## Goals

- An author deletes one of their messages or files; an owner or admin removes anyone's within the rank rule.
- The message keeps its id, sequence, thread links, author, and time; its text becomes a fixed sentence; its mentions and files go.
- File bytes are queued for deletion in the same transaction, so counted storage drops at once.
- One tenant audit row per deletion, with ids and field names only.
- One `entry_redactions` row per changed entry, so the redaction feed carries it to DorkOS.
- No change to any existing wire object or stream event.

## Non-Goals

- Editing messages.
- Host authority removing content (the takedown spec, which reuses this module).
- A delete action in the DorkOS app's room view. The server route accepts DorkOS credentials; the DorkOS UI is a follow-up.
- Deleting finished exports that contain the message (they expire on their own).
- A wire flag that lets clients style tombstones (the same deferral as erasure: it would change the strict entry schema).
- Time or effort estimates.

## Technical Dependencies

| Dependency                                 | Used for                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Member erasure 1.1 (#2029, migration 0013) | `entry_redactions`, `community_content_versions`, `entries_author_key_unique`, `tombstone`/`queueBlobs` code to move |
| Member erasure 2.1 (redaction feed)        | task 1.3 only: the browser's live update and the DorkOS mirror test                                                  |
| `pg` + hand-written SQL migrations         | one migration, **the next free number at build time** (after 0013 erasure, 0014 hold, 0015 short names, 0016 import) |
| `zod` ^4                                   | one new response schema, `CommunityWireEntryRemoveResponseSchema`                                                    |

No new runtime dependency.

## Detailed Design

### Tombstone texts

| Removed by                  | `entries.text` becomes                           | `removed_by` |
| --------------------------- | ------------------------------------------------ | ------------ |
| the author (or their agent) | `This message was deleted.`                      | `author`     |
| the owner or an admin       | `This message was removed by a community admin.` | `moderator`  |
| the host (takedown spec)    | `This message was removed by the host.`          | `host`       |

The constants live in `src/content-removal.ts` as `REMOVED_ENTRY_TEXT`. Member erasure keeps its own text (`This message was erased.`) and author name (`Erased member`/`Erased agent`); erasure wins over a removal (an erased author's removed messages become erased tombstones), and a removal of an already erased entry changes nothing.

`author_display_name`, `author_member_id`, `author_agent_id`, `seq`, `parent_entry_id`, `thread_root_entry_id`, `created_at`, and `idempotency_key` are kept. `payload_hash` becomes `tombstonePayloadHash(text, parentEntryId)`: SHA-256 of `{"text":<tombstone>,"mentions":[],"parentEntryId":<unchanged>,"attachmentIds":[]}`, the post payload shape (the erasure helper gains the `text` parameter). No hash of the deleted text remains.

On the wire the entry is an ordinary `CommunityWireEntry` with the tombstone text, `mentions: []`, `attachments: []`. The Community browser renders an entry whose text equals one of the three constants (or the erasure constant) in muted italics without a menu; any other client shows the sentence as text.

### Retry of the original post

`POST /channels/:id/entries` looks up `(author, channel, idempotency_key)` as today. When the found row has `removed_at` or `erased_at` set, it returns that row's current projection with `200` (repeated) whatever the request payload, and never inserts. (Erasure rewrites its key to `erased:<id>`, so an erased row is never found by the original key; the check is for removals.) A delete can therefore never be undone by an outbox retry after a lost response.

### Who may delete

The actor is resolved by a new `requireRemovalPrincipal(c, auth, pool)` in `data.ts`: a browser session for a live member; a connection grant with `post` in its scopes and not `history_only`; or an agent credential. A host API key answers `401` (as on every content route). Then, inside the transaction, with the target's author known:

| Actor                    | May remove                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| an agent credential      | entries it authored; files it uploaded                                                                                                                                                      |
| a member (`member` role) | entries authored by them or by an agent they own; files uploaded by them or by an agent they own                                                                                            |
| an admin                 | the above, plus anything authored or uploaded by someone who is not the owner and not an **active** admin (members, their agents, former admins, erased husks, imported historical members) |
| the owner                | anything in the community                                                                                                                                                                   |

Refused: `403 FORBIDDEN` "You can't remove this message." An entry or file id that is not in the path's community answers `404 NOT_FOUND`, the same as an unknown id.

### Lifecycles

Allowed in `active`, `archived`, and `held` (removal is not growth, the erasure rule; this also lets an owner clean up a held community). `suspended` answers `503 COMMUNITY_SUSPENDED` and `deletion_pending` answers `423 COMMUNITY_DELETION_PENDING`, as every member request does. An archived channel is not a barrier.

The lifecycle check is the community row taken `FOR SHARE`, in the same shape as the other member paths, so a lifecycle change waits for an open removal.

### Routes

Tenant routes, each under `/api/v1/communities/:communityId/…` and the single-community alias:

| Route                               | Result                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DELETE /entries/:entryId`          | `200 { entry }` (the tombstone). Repeating it on a removed or erased entry returns the current entry, writes nothing, and is still `200`                                                |
| `DELETE /attachments/:attachmentId` | Bound file: `200 { entry }` (the message without that file, or its tombstone if nothing is left). Unbound upload (no message yet): `204`. Repeating it answers `404` (the file is gone) |

Responses use a new strict schema in `@dorkos/shared/community-wire`, `CommunityWireEntryRemoveResponseSchema = z.strictObject({ entry: CommunityWireEntrySchema })` (the post receipt carries a separate `cursor`, which a removal does not need). No request body. No new error code. The new schema is only parsed by the same-origin browser bundle and, later, DorkOS; no existing object changes.

### The removal procedure

`src/content-removal.ts`, one transaction per call:

```ts
/** Replace an entry's content with a tombstone and remove its mentions and files, in place. */
export async function removeEntry(
  client: PoolClient,
  input: { communityId: string; entryId: string; removedBy: 'author' | 'moderator' | 'host' }
): Promise<{ changed: boolean; channelId: string; blobKeys: string[] }>;

/** Remove one file; tombstone its message when nothing is left in it. */
export async function removeAttachment(
  client: PoolClient,
  input: { communityId: string; attachmentId: string; removedBy: 'author' | 'moderator' | 'host' }
): Promise<{ entryId: string | null; entryTombstoned: boolean; blobKeys: string[] }>;
```

`removeEntry`:

1. The caller has taken `communities` `FOR SHARE` and checked the lifecycle and the actor.
2. `SELECT … FROM entries WHERE id=$2 AND community_id=$1 FOR NO KEY UPDATE` (not `FOR UPDATE`: a reply holds `FOR KEY SHARE` on its parent while holding its channel; the key never changes). Missing: `404`. `removed_at` or `erased_at` already set: return `changed: false`.
3. `UPDATE entries SET text=<tombstone>, payload_hash=<tombstone hash>, removed_at=now(), removed_by=$3`.
4. `DELETE FROM entry_mentions WHERE community_id=$1 AND entry_id=$2`.
5. `DELETE FROM attachments WHERE community_id=$1 AND entry_id=$2 RETURNING blob_key`, then `queueBlobs(client, communityId, keys)` (moved from `erasure.ts`: `managed_blobs.state='pending_delete'` for `committed`/`stored` rows plus a `pending_blob_deletions` row).
6. `INSERT INTO entry_redactions(community_id, channel_id, entry_id)`.
7. `bumpContentVersion(client, communityId)` (moved from `erasure.ts`).

`removeAttachment` locks the file's entry `FOR NO KEY UPDATE` first (when bound), deletes the one `attachments` row, queues its blob, and then: if the entry's `text` is empty and it has no other file, it runs `removeEntry` steps 3 to 6 on it; otherwise it inserts one `entry_redactions` row for the entry (its `attachments` list changed). It bumps the content version when bound. An unbound upload has no entry and no redaction row.

The route then writes the tenant audit row (`audit_events`: `actor_kind='member'`, `actor_member_id` the member or the agent's owner, action `entry.delete` or `entry.remove` or `attachment.delete` or `attachment.remove` by actor kind, `subject_id` the entry or file id, `changed_fields` `{text,mentions,attachments}` or `{attachments}`, no values) in the same transaction, and returns the projection. A no-op repeat writes no audit row.

**Refactor.** `erasure.ts` imports `queueBlobs`, `bumpContentVersion`, `tombstonePayloadHash`, and the redaction insert from `content-removal.ts` instead of defining them. Its behaviour does not change; the erasure suites prove it.

### Invariant for every content change

Any code that changes what an entry shows (text, mentions, files, author name) writes one `entry_redactions` row for that entry and bumps the content version in the **same** transaction. Erasure, this spec, and the takedown all follow it; the export-any-size spec relies on it to rebuild only what changed. A test enumerates every `UPDATE entries` and `DELETE FROM attachments`/`entry_mentions` statement in `apps/community/src` (a source scan) and fails if one sits outside `content-removal.ts`, `erasure.ts`, the deletion worker, or the import restore.

### Exports

A removal bumps the content version, so an owner or personal export whose snapshot predates it refuses to commit today (`409`, "The community changed while this export was being made. Try again."), and, once `specs/community-export-any-size/` lands, rebuilds only the affected part. Finished exports are not deleted; they expire on their own. The delete dialog says so.

### Propagation

- **DorkOS mirrors** read the redaction feed (member erasure task 2.1): each `entry_redactions` row yields the entry's current projection, and the mirror rewrites its cached text, mentions, and file list. Nothing here is specific to erasure. DorkOS never caches file bytes (it fetches them on demand), so a removed file answers `404` to DorkOS at once.
- **The Community browser** updates its own view from the route's response. Other open tabs poll `GET …/channels/:id/redactions` for the open channel every 30 seconds and on window focus, from a cursor they keep in memory, and replace entries in place (task 1.3, after erasure 2.1).
- **Live stream:** unchanged (no new event type; strict parsers).

### Data model changes (migration: next free number at build time)

- `entries.removed_at timestamptz NULL`, `entries.removed_by text NULL CHECK (removed_by IN ('author','moderator','host'))`, `CHECK ((removed_at IS NULL) = (removed_by IS NULL))`. `host` is allowed now so the takedown needs no second change to this check.
- `src/schema.ts` mirrors it.
- Old code ignores both columns (a removed entry reads as an ordinary entry with the tombstone text).

### Code structure

| Path                                                                                               | Change                                                                 |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/community/src/content-removal.ts` (new)                                                      | `REMOVED_ENTRY_TEXT`, `removeEntry`, `removeAttachment`, moved helpers |
| `apps/community/src/erasure.ts`                                                                    | imports the moved helpers                                              |
| `apps/community/src/data.ts`                                                                       | `requireRemovalPrincipal`                                              |
| `apps/community/src/routes/entries.ts`                                                             | `DELETE /entries/:entryId`; replay of a removed entry                  |
| `apps/community/src/routes/attachments.ts`                                                         | `DELETE /attachments/:attachmentId`                                    |
| `apps/community/src/app.ts`                                                                        | register both routes on the qualified and alias paths                  |
| `packages/shared/src/community-wire.ts`                                                            | `CommunityWireEntryRemoveResponseSchema`                               |
| `apps/community/migrations/<next>_entry_removal.sql`, `src/migrate.ts`, `src/schema.ts`            | columns above                                                          |
| `apps/community/src/browser/` (message and file menus, confirm dialog, tombstone style, feed poll) | UI                                                                     |

## User Experience

Copy follows `writing-for-humans`.

- **Message menu.** On your own message: **Delete**. On someone else's, for an owner or admin allowed by the rank rule: **Remove**. Confirm dialog:
  - Delete: "Delete this message? Everyone will see "This message was deleted." in its place. Its files are deleted too. This can't be undone." [Cancel] **Delete**
  - Remove: "Remove this message? Everyone will see "This message was removed by a community admin." in its place. Its files are deleted too. This can't be undone." [Cancel] **Remove**
  - Both add: "People who already saw it may have a copy, and exports made before now still contain it until they expire."
- **File menu** (on a file chip): **Delete file** / **Remove file**, with "Delete this file? It's removed from the message and deleted. This can't be undone."
- **After:** the message shows the sentence in muted italics, keeps its place and its replies, and has no menu. A thread whose root is deleted still opens.
- **Errors:** plain sentences from the server ("You can't remove this message.", "This community is suspended.").

## Testing Strategy

Integration tests on real PostgreSQL and both BlobStores (`vitest.pg.config.ts`, `vitest.s3.config.ts`), using the tenancy harness. Each test has a purpose comment.

### Acceptance criteria that discriminate

- **AC-1 — Thread shape.** Member M posts root R with a mention of Q and one file; Q replies to R. M deletes R. R keeps `id`, `seq`, `parent_entry_id`, `thread_root_entry_id`, `created_at`, author id and author name; history returns R with text `This message was deleted.`, `mentions: []`, `attachments: []`, parsed by the unchanged `CommunityWireEntrySchema`; Q's reply still names R as parent; the thread query on R returns Q's reply; a page cursor and a stream resume cursor taken before the delete still work (no `410`). Fails on a hard delete or a filter.
- **AC-2 — Nothing left.** R's text contains `canary-text`, its file is named `canary-file.txt` with bytes containing `canary-bytes`. After the delete and one blob sweep: a scan of every `text`, `varchar`, `text[]`, `json`, and `jsonb` column in the `public` schema (from `information_schema.columns`, never a hand list), every object in the BlobStore, and captured logs finds no canary, no SHA-256 of the file bytes, and no SHA-256 of R's original payload. Control: before the delete the scan finds each. `GET /attachments/<id>` answers `404`. Fails if any copy or hash remains.
- **AC-3 — Storage at once.** With a storage limit set, host usage `countedBytes` drops by the file's size in the same request (no sweep), and an upload that would have exceeded the limit before the delete now succeeds. Fails if `pending_delete` still counts or the queue is outside the transaction.
- **AC-4 — Authority matrix.** Member deletes own (200), own agent's (200), another member's (403). Agent credential deletes its own (200), a sibling agent's (403). Admin removes a member's (200), the owner's (403), an active admin's (403), a former admin's (200), an erased husk's (200). Owner removes any (200). A grant without `post`, and a `history_only` grant, answer `403`. A host API key answers `401`. An entry id from community B under A's path answers `404`. Every refused request changes no row (row counts and a digest of A's `entries` before and after).
- **AC-5 — Lifecycles.** Allowed in `active`, `archived`, `held`; `503` when `suspended`; `423` when `deletion_pending`.
- **AC-6 — Repeat and replay.** Deleting R twice returns the same tombstone and leaves exactly one audit row and one `entry_redactions` row. M retrying the original post with its original key returns `200` with the tombstone and no new entry, with the original payload and with a different payload. Fails if a retry recreates content.
- **AC-7 — One file.** A message with text and two files: deleting one leaves the text and the other file, writes one redaction row, and the deleted file answers `404`. A message with empty text and one file: deleting the file tombstones the message. An unbound upload: its uploader deletes it (`204`), its blob is queued, no redaction row.
- **AC-8 — Concurrency.** A reply to R and a delete of R started together (barrier) both succeed without a deadlock error. A delete of R racing an erasure of M converges to the erased tombstone. An export snapshotted before the delete and committed after it (test hook) answers `409` and leaves no blob.
- **AC-9 — Audit.** Each removal writes one `audit_events` row with the right action, actor, subject, and changed fields; a JSON value scan of the row finds no canary.
- **AC-10 — Refactor is behaviour-preserving.** The member erasure suites (#2029) pass unchanged after `erasure.ts` imports the moved helpers.
- **AC-11 — Invariant guard.** The source scan finds no entry-changing statement outside the allowed modules; adding one in a test fixture file under `src/` makes it fail.
- **AC-12 — Propagation (task 1.3).** After R is deleted, the redaction feed for its channel returns R's tombstone projection. A DorkOS test server mirroring the channel replaces the cached text after one feed sync (reusing the erasure task 2.1 harness). A second browser tab showing R shows the tombstone within one poll.

### Other tests

- Unit: `tombstonePayloadHash(text, parent)` against a fixed vector; the rank rule table.
- Browser (`apps/community/browser-tests`): Delete on own message, Remove as admin, the confirm dialog's sentences, tombstone rendering, the absence of a menu on a tombstone, Delete file.

## Performance Considerations

One short transaction per removal, touching one entry, its mentions and files, one redaction row, and the content version row (contended only by export commits). No lock is held on the channel, so posts in the channel continue.

## Security Considerations

- Authorization follows the author and the existing rank rule; host credentials cannot reach these routes.
- Nothing about the deleted content survives on the Community server: text replaced, payload hash replaced, mentions and files deleted, blobs queued in the same transaction.
- Named leftovers, stated in the UI and docs: copies people already saw or downloaded, finished exports until they expire (at most the export lifetime), DorkOS mirrors until their next feed sync, and the host's database and object backups for as long as the host keeps them. The `idempotency_key` stays; it is a client-chosen retry key, not content.
- A removal is permanent and has no grace period; the confirm dialog says so.

## Documentation

- `apps/community/API.md`: the two routes, who may call them, the tombstone texts, the replay rule.
- `docs/guides/communities.mdx`: deleting and removing messages and files, what people see, what cannot be recalled.
- `apps/community/OPERATIONS.md`: storage is freed at once; bytes leave the store at the next sweep.
- A changelog fragment in `changelog/unreleased/`.

## Implementation Phases

- **Phase 1, task 1.1 — Server.** Migration, `content-removal.ts`, erasure refactor, both routes, replay rule, audit, invariant guard, docs. AC-1 to AC-11.
- **Phase 1, task 1.2 — Browser.** Menus, dialogs, tombstone rendering, own-view update. Browser tests. Parallel with nothing; after 1.1.
- **Phase 1, task 1.3 — Live propagation.** After member erasure task 2.1 (the feed): the browser poll and the DorkOS mirror test. AC-12.

### Landing order with the other hosting gaps

1. Member erasure 1.1 (#2029) first: this spec moves its helpers.
2. This spec's task 1.1 creates `content-removal.ts`.
3. The host takedown (`specs/community-host-takedown/`, a launch blocker) builds on it: its item takedown is `removeEntry`/`removeAttachment` with `removedBy: 'host'` plus evidence. So task 1.1 here is on the launch path even though deletion itself is not a launch blocker.
4. `specs/community-export-any-size/` relies on the invariant above to rebuild only changed parts.

### Backout

Revert the code; the two columns stay and old code ignores them. Messages already removed keep their tombstone text, which old code shows as ordinary text. Files already removed stay removed.

## Open Questions

None. Resolved while specifying:

- ~~Show who removed a message?~~ (RESOLVED) **Answer:** the kind of remover (author, community admin, host), never the person. **Rationale:** honest about what happened without turning moderation into a target.
- ~~Keep the idempotency key?~~ (RESOLVED) **Answer:** yes, and a retry returns the tombstone. **Rationale:** a lost response followed by a retry must never repost deleted content.
- ~~Delete finished exports?~~ (RESOLVED) **Answer:** no, they expire; the dialog says so. The takedown deletes them because its content may be illegal.
- ~~Undo window?~~ (RESOLVED) **Answer:** none. **Rationale:** the brief asks for storage freed at once; a confirm dialog guards mistakes.
- ~~Mark a removed file inside a message that keeps its text?~~ (RESOLVED) **Answer:** no marker now; a wire field for it joins the erasure spec's deferred tombstone flag. **Rationale:** the strict wire cannot carry it without breaking older installations.

## Related ADRs

- `260923-214411` — Removing a message or file tombstones it in place through one shared module (accepted, from this spec)
- `260923-134614` — Erasure tombstones a member's history in place and deletes everything else
- `260923-134616` — Member erasure belongs to the person and the community owner
- `260920-201101` — Separate community retention from permanent tenant deletion (blob inventory and cleanup)

## References

- DOR-2282 — this specification
- `specs/community-member-erasure/02-specification.md` (DOR-2247; tasks 1.1 and 2.1)
- `specs/community-host-takedown/02-specification.md` (DOR-2281)
- `specs/community-export-any-size/02-specification.md` (DOR-2283)
- #2029: `apps/community/src/erasure.ts`, `migrations/0013_member_erasure.sql`
- `apps/community/src/routes/entries.ts`, `routes/attachments.ts`, `routes/members.ts`, `routes/exports.ts`, `storage/managed-blobs.ts`
- `packages/shared/src/community-wire.ts` (`CommunityWireEntrySchema`)
