---
slug: community-host-takedown
number: 260923-214420
created: 2026-09-23
status: specified
linear-issue: DOR-2281
project: Cloud-Hosted Communities
---

# Let a host take down illegal content

**Status:** Approved (decisions pre-authorized by the operator for this programme)
**Author:** Claude (for DOR-2281)
**Date:** 2026-09-23

## Overview

A host can take down one message, one file, or a whole community at once, by id, when it learns the content is illegal. Members stop seeing it immediately: a message shows `This message was removed by the host.`, a file disappears from its message, and a community reads "This community was removed by its host." Nobody gets an export window first. If the host has configured an evidence store, the server writes a copy of what it removed there, with who posted it, before the bytes leave primary storage. The API never returns that content to the host; the evidence store is outside the API and write-only for the server. The owner and the author see a short statement of reasons unless the host withholds it. Every takedown is audited.

## Background / Problem Statement

- The only host path to removing content is host-started deletion (`routes/host-lifecycle.ts`, #2036): it needs a hold with a published notice date at least 7 days old, and throughout the hold the owner can export. For illegal content that hands the uploader a copy and leaves the content up for a week.
- There is no host power over a single message or file, and a whole-community deletion is far too blunt for one illegal post in a large community.
- Host authority must not read content through the API (ADR `260923-121150`; the tenancy contract). Yet a host that removes illegal material is often required to preserve it for the authorities.
- Reports arrive with community and entry UUIDs (host-operator "Host links": the Report link adds `?community=<uuid>&entry=<uuid>`), never content.

## Goals

- Take down an entry, a file, or a community immediately, by id, with a dedicated scope.
- Members see an honest tombstone or removal notice at once; nothing is readable or downloadable afterwards, including through ready exports.
- When configured, a complete evidence copy (content, files, author, account, sessions) lands in a separate store the API cannot read, before the primary bytes are deleted.
- A statement of reasons for the owner and the author, withheld when the host says so.
- A full audit trail in the host audit and in the community's own audit.
- DorkOS mirrors replace cached copies through the redaction feed.

## Non-Goals

- Returning content to host authority through any route.
- Automatic detection (hash matching, classifiers) or filing reports with authorities.
- Banning an account across the host (follow-up: host account suspension).
- A two-person rule (rejected for now; see Open Questions).
- Taking down a `pending_owner` community's content: nobody can read it; the host abandons it (host-operator P3/abandon).
- Reaching copies outside the Community server: people's own downloads, what their agents saved, DorkOS mirrors before they sync, and the host's backups.
- Time or effort estimates.

## Technical Dependencies

| Dependency                                            | Used for                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Host keys and authority (host-operator P1, on `main`) | `requireHostAuthority`, `assertHostActor`, `recordHostAudit`, key scopes                               |
| Host hold (#2036, 0014)                               | `deletion_pending` host requester columns, `deletion_from_state`, host-requested deletion jobs         |
| Member erasure 1.1 (#2029, 0013)                      | `entry_redactions`, content version, erasure worker (gated here)                                       |
| `specs/community-single-item-delete/` task 1.1        | `content-removal.ts` (`removeEntry`, `removeAttachment`, `removed_by='host'`, the host tombstone text) |
| `specs/community-export-any-size/` task 1.2           | phase 2 only: the export job with `scope='evidence'`                                                   |
| Member erasure 2.1 (redaction feed)                   | DorkOS mirrors replace cached text (not needed for the server-side takedown)                           |
| `@aws-sdk/client-s3` 3.1135.0                         | the S3 evidence sink (`PutObject` with `ChecksumSHA256` only)                                          |
| `pg` + hand-written SQL migrations                    | one migration per phase, **the next free number at build time**                                        |

## Detailed Design

### Authority

- New scope **`communities:takedown`**, added to `CommunityAdminHostApiKeyScopeSchema` (keys may hold 1 to 5 scopes) and to the `host_api_keys_scopes` check. A host operator's session holds every scope, as today, but each takedown or reversal by a **person** also carries `password` in the body and is refused `403 REAUTH_REQUIRED` without a correct one (`auth.api.verifyPassword`, as key issuance does). A key needs only the scope.
- Content routes still refuse every host credential (`401`); nothing here changes that.
- Every takedown mutation runs `assertHostActor` inside its transaction, so a key revoked first always wins.

### Routes (host plane)

| Route                                                   | Body                                  | Result                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/host/communities/:id/takedowns`           | `CommunityAdminTakedownRequestSchema` | `201 { takedown }`; a replay of the same `idempotencyKey` returns it with `200`; a different body under the key is `409 IDEMPOTENCY_CONFLICT` |
| `GET /api/v1/host/takedowns?communityId=&after=&limit=` | —                                     | a page of takedowns, newest first                                                                                                             |
| `GET /api/v1/host/takedowns/:takedownId`                | —                                     | `{ takedown }`                                                                                                                                |
| `POST /api/v1/host/takedowns/:takedownId/reverse`       | `{ lifecycleVersion, password? }`     | `200 { takedown }`; community takedowns only (below)                                                                                          |

All four need `communities:takedown`. An entry or file id that does not belong to the path's community answers `404 NOT_FOUND`, the same as an unknown id.

```ts
/** Why the host removed something. Shown to the owner and author as one plain sentence. */
export const CommunityAdminTakedownCategorySchema = z.enum([
  'child_safety',
  'illegal_content',
  'legal_order',
  'terms_violation',
]);
export const CommunityAdminTakedownRequestSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(200),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('entry'), entryId: id }),
    z.strictObject({ kind: z.literal('attachment'), attachmentId: id }),
    z.strictObject({
      kind: z.literal('community'),
      lifecycleVersion: version,
      confirmIdSuffix: z.string().length(8),
    }),
  ]),
  category: CommunityAdminTakedownCategorySchema,
  reference: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/)
    .nullable(), // the host's case number; never free text
  notify: z.boolean(),
  password: z.string().min(1).optional(), // required for a person, refused for a key
});
/** A takedown as host authority sees it: ids and states only, never content. */
export const CommunityAdminTakedownSchema = z.strictObject({
  id,
  communityId: id,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('entry'), entryId: id }),
    z.strictObject({ kind: z.literal('attachment'), attachmentId: id, entryId: id.nullable() }),
    z.strictObject({ kind: z.literal('community') }),
  ]),
  category: CommunityAdminTakedownCategorySchema,
  reference: z.string().nullable(),
  notify: z.boolean(),
  actor: z.strictObject({ kind: z.enum(['person', 'api_key']), id: z.string() }),
  state: z.enum(['active', 'reversed']),
  evidence: z.strictObject({
    state: z.enum(['pending', 'retrying', 'stored', 'not_configured', 'nothing_to_preserve']),
    location: z.string().nullable(), // "takedowns/<id>/attempt-<n>/" once stored
    attempts: z.int().nonnegative(),
  }),
  deleteAfter: timestamp.nullable(), // community takedowns
  createdAt: timestamp,
  reversedAt: timestamp.nullable(),
});
```

### Item takedown (entry or file)

Allowed in every lifecycle except `pending_owner` (including `suspended` and `deletion_pending`, where the content might otherwise be purged without evidence). One transaction:

1. Lock the community `FOR SHARE`; `assertHostActor`.
2. Lock the target entry `FOR NO KEY UPDATE` (for a file, its entry when bound). Build the **evidence record** (below) from the rows as they are now.
3. Call `removeEntry` or `removeAttachment` from `content-removal.ts` with `removedBy: 'host'` and `holdBlobs: true` (new option): files are detached and their `managed_blobs` rows move to a new state `evidence_hold` instead of `pending_delete`, so the bytes survive but nothing can reach them. With no evidence store configured, `holdBlobs` is false and they go straight to `pending_delete`. An entry already removed by its author or a moderator is relabelled to the host tombstone (`removed_by='host'`, one redaction row); an erased entry is left as erased. In both cases the record notes `contentAlreadyRemoved: true` and evidence is `nothing_to_preserve` unless files were still held.
4. Delete every `ready` export in the community and queue its blobs (the helper erasure uses, moved to `content-removal.ts` as `deleteReadyExports`).
5. Insert `community_takedowns` and, when a store is configured, `takedown_evidence_staging(takedown_id, record jsonb, blob_keys text[])`.
6. `recordHostAudit` (`takedown.create`, `changed_fields` `{target.kind}`), and a tenant `audit_events` row (`actor_kind='host'`, no member, action `entry.takedown` or `attachment.takedown`, `subject_id` the target id).

After commit the members, DorkOS, and every route see the tombstone; `GET /attachments/:id` answers `404`; the redaction feed carries the change.

### Community takedown

Allowed from `active`, `archived`, `held`, `suspended`, and `deletion_pending`; `pending_owner` is refused (`409`, abandon it instead). The request carries `lifecycleVersion` and the last eight characters of the community id. One transaction:

1. Lock the community `FOR UPDATE`; check the version and suffix; `assertHostActor`.
2. `revokeTenantAccess` (every grant, agent credential, invitation, pairing, pending admission).
3. Set `lifecycle='deletion_pending'`, `delete_requested_by_host_actor`, `delete_requested_by=NULL`, `takedown_id`, and `delete_after = now() + COMMUNITY_TAKEDOWN_REVERSAL_HOURS` (default 72, range 0 to 720). `deletion_from_state` records the prior state (`active`, `archived`, `held`, or `suspended`, with `deletion_from_prior_state` as the hold spec defines); from an owner-requested `deletion_pending` the existing origin columns stay and the job's requester becomes the host, so the owner can no longer cancel. Upsert `community_deletion_jobs` with the host requester, `takedown_id`, and `delete_after`.
4. Delete every ready export; cancel open export jobs other than the evidence one.
5. Insert `community_takedowns`; when a store is configured, insert an export job with `scope='evidence'` (`specs/community-export-any-size/`: no requester, allowed in `deletion_pending`, never downloadable), else evidence is `not_configured`.
6. Host audit `takedown.create`.

Members and every installation get `423 COMMUNITY_DELETION_PENDING` with the message "This community was removed by its host." (`tenant-context.ts` reads `takedown_id`). The owner cannot export or cancel.

**Reversal.** `POST /host/takedowns/:id/reverse` is allowed only for a community takedown, while its deletion job is `waiting` and `delete_after` has not passed, and only when the takedown did not start from an owner-requested deletion (the host cannot restore an owner's own deletion; `409`). It sets `lifecycle='suspended'` with `suspended_from_state` = the state before the takedown (for a takedown from `suspended`, its own `suspended_from_state`), clears the deletion columns, deletes the job, marks the takedown `reversed`, and audits `takedown.reverse`. Credentials stay revoked; the host resumes the community when it is ready. Stored evidence stays. Item takedowns cannot be reversed (`409`): their content is gone.

### Evidence

**The store.** Configured by a second, independent set of variables; all optional, validated in `parseConfig` like the primary store:

| Variable                                                                                                  | Meaning                                                                          |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `COMMUNITY_EVIDENCE_DRIVER`                                                                               | `filesystem` or `s3`; unset means no evidence store                              |
| `COMMUNITY_EVIDENCE_PATH`                                                                                 | absolute; must not equal or sit inside `COMMUNITY_STORAGE_PATH` (and vice versa) |
| `COMMUNITY_EVIDENCE_S3_BUCKET`, `_REGION`, `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_PREFIX` | as the primary S3 settings; bucket plus endpoint must differ from the primary's  |

`src/evidence/sink.ts` exposes one operation, `put(path, source, { sha256, byteSize })`. The S3 sink sends `PutObject` with `ChecksumSHA256` and `If-None-Match: *` and never calls `GetObject`, `ListObjects`, `HeadObject`, or `DeleteObject`, so the host can (and the operations guide says it should) give the server a put-only credential and turn on object lock. The filesystem sink writes a temporary name opened with `wx` in the target directory, `fsync`s, and renames. Paths are server-built: `takedowns/<takedownId>/attempt-<n>/…`. The sink stages through local disk exactly as the primary store does (at most one file or one archive segment at a time).

**What is written.**

```
takedowns/<id>/attempt-<n>/files/<attachmentId>          item takedowns: each held file
takedowns/<id>/attempt-<n>/archive.zip.000001 … .NNNNNN   community takedowns: the evidence export's segments, in order
takedowns/<id>/attempt-<n>/record.json                   written last; its presence marks a complete attempt
```

`record.json` (schema `CommunityEvidenceRecordV1`, in `packages/shared/src/community-admin-wire.ts` so a host's tooling can parse it):

- `takedown`: id, created time, actor kind and id (and the operator's display name for a person), category, reference, `notify`;
- `server`: `COMMUNITY_PUBLIC_URL` and the server version;
- `community`: id, name, lifecycle at takedown;
- for an item: `channel` (id, name), `entry` (id, `seq`, created time, **text**, parent and thread ids, mention ids, `contentAlreadyRemoved`), `author` (member id, display name, handle, role, human or agent, the agent's owner member id), `account` (account id, email, created time, and each current session's `createdAt`, `ipAddress`, and `userAgent` as Better Auth stored them), and `files` (id, name, content type, byte size, upload time, uploader, `path`, SHA-256 of the written bytes);
- for a community: `archive` (`format: 'zip64'`, `manifestVersion: 2`, the segment paths with sizes and SHA-256, the total size, and "concatenate the segments in order to get one .zip"). The archive itself holds every member's email (evidence scope keeps emails, like owner scope);
- `notes`: "The Community server does not log request IP addresses; session IP addresses are those the sign-in stored."

**The worker** (`src/takedown-worker.ts`, started from `main.ts`) claims a takedown whose evidence is `pending` or `retrying` and due, with `FOR UPDATE SKIP LOCKED` and a 5-minute lease, and runs attempt `n = attempts + 1`:

- **Item:** stream each held blob from the primary store into the sink, computing SHA-256 and comparing it with the file's stored checksum; then write `record.json` (the staged record plus the file hashes and paths). In one transaction: delete the staging row, move the held blobs to `pending_delete` with `pending_blob_deletions` rows, set evidence `stored` with its location.
- **Community:** wait until the evidence export is `ready` (or `failed`, which fails the attempt), then stream each segment into `archive.zip.NNNNNN`, write `record.json`, set evidence `stored`, and queue the evidence export's segments for deletion.
- **Failure:** increment `attempts`, record an error class (never a message), set `retrying`, back off with the existing cleanup backoff (capped at one hour). Log every failure. The host page shows it.

**Gates.** While a takedown's evidence is `pending` or `retrying`:

- the tenant deletion worker skips that community (for a community takedown, deletion runs at the later of `delete_after` and evidence stored);
- for a community takedown, the erasure worker skips membership erasures in that community, so the evidence is what was there at the takedown. (Item takedowns need no erasure gate: their record and bytes are already staged apart from the member's rows, and erasure never touches `evidence_hold` blobs.)
- `evidence_hold` blobs count toward no limit (host usage shows them with pending-delete bytes) and the pending-deletion sweep ignores them.

### Notices

- **Categories** and their sentences (`writing-for-humans`):
  - `child_safety`: "It was removed to protect children."
  - `illegal_content`: "It was reported to the host as illegal."
  - `legal_order`: "The host received a legal order to remove it."
  - `terms_violation`: "It broke the host's terms."
  - With a reference: "Reference: {reference}." With the host's report link configured: "If you think this is a mistake, contact the host." linking to it.
- **Item takedowns.** New tenant route `GET /api/v1/communities/:communityId/takedowns`: the owner and admins see every item takedown in the community with `notify: true`; any other member sees those whose target they (or an agent they own) authored or uploaded. Each item: takedown id, target kind, entry id, file id, channel id, category, reference, time. No content. The browser shows the owner a "Removed by the host" list in Settings and shows an author a banner once per takedown: "The host removed one of your messages on {date}. {category sentence}".
- **Community takedowns.** `GET /owner/deletion` (already allowed in `deletion_pending`) gains `requestedBy: 'owner' | 'host'` and `takedown: { category, reference, createdAt } | null` (null when `notify: false`). The chooser shows the owner "The host removed {community} on {date}. {category sentence}" and everyone else "This community was removed by its host."
- **`notify: false`** hides the takedown from both routes and from the owner's deletion status; the tombstone and the removal message still show, because content cannot be both gone and unexplained. The host audit records `notify`.

### Report link: files

The host-links Report item on a file adds `&attachment=<uuid>` beside the community and entry UUIDs, so a host can take down one file (host-operator task 6.1; done here if 6.1 has landed, otherwise added to 6.1's description).

### Propagation

Item takedowns write `entry_redactions` rows through `content-removal.ts`, so the redaction feed (member erasure task 2.1) carries the host tombstone to DorkOS mirrors and to open browser tabs (`specs/community-single-item-delete/` task 1.3). DorkOS never caches file bytes, so a taken-down file answers `404` to DorkOS at once; cached **text** stays in mirrors until task 2.1 ships (see Security). A community takedown revokes every credential, so installations stop reading at once; their existing mirrors are not rewritten.

### Data model changes

**Phase 1 migration (next free number at build time):**

- `host_api_keys_scopes`: `cardinality(scopes) BETWEEN 1 AND 5` and the subset gains `communities:takedown`.
- `audit_events_actor_kind`: `IN ('member','system','host')`. Any export manifest schema that enumerates an audit row's `actor_kind` (`CommunityExportManifestV1Schema` once import lands, and version 2's audit row schema) accepts `host` too, so an owner export made after a takedown still imports.
- `managed_blobs` state check gains `evidence_hold` (metadata rule as `committed`: size and checksum set).
- `community_takedowns(id uuid PK, community_id uuid NOT NULL, target_kind CHECK IN ('entry','attachment','community'), entry_id uuid NULL, attachment_id uuid NULL, category CHECK IN (…four…), reference text NULL CHECK (~ '^[A-Za-z0-9._:-]{1,64}$'), notify bool NOT NULL, actor_kind CHECK IN ('person','api_key'), actor_user_id text NULL, actor_api_key_id uuid NULL, idempotency_key text UNIQUE, payload_hash text, state CHECK IN ('active','reversed'), evidence_state CHECK IN ('pending','retrying','stored','not_configured','nothing_to_preserve'), evidence_location text NULL, evidence_attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz, lease_until timestamptz, last_error_class text NULL CHECK (~ '^[A-Z][A-Z0-9_]{0,63}$'), created_at, reversed_at)` with target-shape and exactly-one-actor checks. **No foreign key to `communities`**: the record outlives a deleted community (it holds ids and categories only; the operations guide says how long to keep it).
- `takedown_evidence_staging(takedown_id uuid PK REFERENCES community_takedowns(id), record jsonb NOT NULL, blob_keys text[] NOT NULL)`.
- **Phase 2 migration:** `communities.takedown_id uuid NULL`, `community_deletion_jobs.takedown_id uuid NULL`; the evidence export's link `community_takedowns.evidence_export_id uuid NULL`.
- `src/schema.ts` mirrors all of it.

### Code structure

| Path                                                                                | Change                                                                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/community/src/routes/host-takedowns.ts` (new)                                 | the four host routes                                                                         |
| `apps/community/src/takedown-worker.ts` (new)                                       | evidence copy, retries, release of held blobs                                                |
| `apps/community/src/evidence/sink.ts` (new)                                         | write-only filesystem and S3 sinks                                                           |
| `apps/community/src/content-removal.ts`                                             | `holdBlobs` option, `deleteReadyExports`                                                     |
| `apps/community/src/host/authority.ts`, `routes/host-keys.ts`, `host-keys.ts` (CLI) | the fifth scope                                                                              |
| `apps/community/src/deletion-worker.ts`, `erasure-worker.ts`                        | evidence gates                                                                               |
| `apps/community/src/routes/administration.ts`, `tenant-context.ts`                  | owner deletion status; the removed-by-host message                                           |
| `apps/community/src/routes/takedown-notices.ts` (new)                               | the tenant notices route                                                                     |
| `apps/community/src/config.ts`                                                      | evidence settings, `COMMUNITY_TAKEDOWN_REVERSAL_HOURS`                                       |
| `packages/shared/src/community-admin-wire.ts`, `community-wire.ts`                  | takedown schemas, `CommunityEvidenceRecordV1`, the notice list, owner deletion status fields |
| `apps/community/src/browser/` (host page, Settings, chooser, banner, Report link)   | UI                                                                                           |

## User Experience

- **Host page** (`/host`, per community): a **Take down** section: target (message id, file id, or the whole community), category, optional reference, "Tell the owner and the author" (checked by default), password for a person, and for a community the id suffix. A warning above it when no evidence store is set: "Takedowns won't keep a copy for the authorities. Set an evidence store first if you need one." A list of takedowns with target, category, time, and evidence state ("Copy saved", "Saving the copy…", "Couldn't save the copy yet; retrying", "No evidence store", "Nothing left to save"), and **Reverse** on a community takedown during its window. The host never sees content here.
- **Members:** the tombstone in place of a message; a file gone from its message; "This community was removed by its host." for a community.
- **Owner:** Settings → "Removed by the host": date, what (message or file), channel, reason sentence, reference. For a community takedown, the chooser line above.
- **Author:** a one-time banner per takedown with the reason sentence.

## Testing Strategy

Integration tests on real PostgreSQL with both BlobStores, a filesystem evidence sink, and an S3 evidence sink stub that records calls and throws on anything but `PutObject`. Each test has a purpose comment.

### Acceptance criteria that discriminate

- **AC-1 — No content through the API.** For every takedown route and response (create, replay, list, get, reverse, and the error paths), a JSON key and value scan finds none of the seeded canaries (message text, file name, file bytes' hash, author name, handle, email). The adversarial matrix of host-operator P1 still passes with a key holding all five scopes (every content route `401`).
- **AC-2 — Authority.** A key without `communities:takedown` gets `403` and no row changes; a person without a password gets `403 REAUTH_REQUIRED`; a revoked key racing a takedown on the lock (hook) fails `401` with nothing changed; a key cannot issue keys with the new scope (key management stays session-only).
- **AC-3 — Item takedown hides at once.** After `POST …/takedowns` for entry E (text `canary-text`, one file `canary.txt`): history shows E with `This message was removed by the host.`, `mentions: []`, `attachments: []`, strict-schema valid; `GET /attachments/<id>` is `404` for every credential; the redaction feed lists E; a ready owner export made before is gone (`404`, blobs queued); one `host_audit_events` row and one tenant `audit_events` row with `actor_kind='host'`.
- **AC-4 — Evidence is complete, then primary is clean.** With the filesystem sink: `takedowns/<id>/attempt-1/record.json` exists and parses with `CommunityEvidenceRecordV1`; it holds the text, the author's name, handle, email, and session IP and user agent; `files/<id>` hashes to the original checksum. After the blob sweep, the AC-1 canary scan over every column in the `public` schema (from `information_schema.columns`) and every primary store object finds none of the canaries (the evidence directory is excluded and asserted separately). Fails if the copy is partial or primary keeps anything.
- **AC-5 — Store down.** With the sink failing: E is hidden immediately (AC-3 holds); its blob stays in the primary store with state `evidence_hold`; evidence goes `retrying` with an error class; the pending-deletion sweep leaves the blob; the tenant deletion worker skips the community. When the sink recovers: `attempt-2/record.json` is written, the blob is released and swept. The S3 stub recorded only `PutObject` calls.
- **AC-6 — No store configured.** Evidence is `not_configured`; blobs go straight to `pending_delete`; the host page shows the warning.
- **AC-7 — Already removed.** Taking down an entry its author deleted relabels it to the host tombstone (one redaction row) and records `nothing_to_preserve` with `contentAlreadyRemoved: true`; an erased entry stays erased.
- **AC-8 — Community takedown.** From each of `active`, `archived`, `held`, `suspended`: every grant, agent credential, invitation, and pairing is revoked in the same transaction; members get `423` with "This community was removed by its host."; the owner cannot export (`423`) or cancel; the evidence export runs in `deletion_pending`; its segments land in the sink with `record.json`, and concatenated they open as a zip whose manifest is version 2 with `scope: 'evidence'` and counts equal to the community's; the deletion worker waits for both `delete_after` and evidence, then deletes the community. From `pending_owner`: `409`. Wrong suffix or stale version: `409`, nothing changed.
- **AC-9 — Reversal.** Within the window the host reverses: lifecycle `suspended` with the right `suspended_from_state`, credentials still revoked, the deletion job gone, stored evidence untouched; after `delete_after` or once deletion started: `409`. Reversing an item takedown: `409`. A takedown of an owner-requested deletion cannot be reversed (`409`), and the owner can no longer cancel it.
- **AC-10 — Erasure waits for community evidence.** An erasure of member P scheduled before a community takedown comes due while evidence is pending: the erasure worker does not run it; after evidence is stored it runs (and the community is later deleted anyway). The evidence archive contains P's messages.
- **AC-11 — Notices.** With `notify: true`: the owner's list shows the item takedown with the category sentence and reference, the author sees their banner, another member sees nothing; the owner's deletion status shows `requestedBy: 'host'` and the takedown. With `notify: false`: all of them show nothing, the tombstone still shows, and the host audit row records `notify=false`.
- **AC-12 — Isolation.** Community B's rows, blobs, and exports are unchanged by every takedown in A.
- **AC-13 — Idempotency.** Replaying a takedown request returns the same takedown with `200` and no second removal, audit row, or evidence attempt; the same key with a different target is `409 IDEMPOTENCY_CONFLICT`.
- **AC-14 — Config.** An evidence path equal to or inside the primary storage path, or the same bucket and endpoint as the primary, fails configuration parsing with a clear message.

### Other tests

- Unit: the evidence record builder (field set, no extra fields), category sentences, path building.
- Browser: the host page section, the warning, the list states; the owner's list; the author banner; the removed-community chooser line.

## Performance Considerations

An item takedown is one short transaction plus a background copy of at most a few files. A community takedown is one transaction plus the evidence export, which is the export job's bounded work; deletion waits for it.

## Security Considerations

- **No content through the API**, proved by AC-1 and the existing adversarial matrix. The evidence store is written by the server with put-only rights and read by the host through its own storage access, as a backup would be. This is the distinction ADR `260923-214421` records beside ADR `260923-121150`.
- **A compromised takedown key** can remove content and (for communities) start a deletion, but cannot read anything. Every use is audited, owners and authors are told unless the host withholds it, and a community takedown can be reversed for `COMMUNITY_TAKEDOWN_REVERSAL_HOURS`. Hosts should give the scope to few keys; the operations guide says so.
- **Evidence holds the most sensitive data the host has** (illegal content, emails, IP addresses). The guide says: a separate bucket or disk, put-only credentials for the server, object lock, access limited to the people who report to authorities, retention as the law requires (for example one year for a US provider's report), and deletion afterwards. Member erasure does not reach the evidence store; the erasure copy's "cannot reach" sentence gains "or copies the host keeps for legal reasons".
- **Content hidden while evidence is pending** remains on the host's primary storage as unreachable bytes until the copy lands. That is the trade-off for never losing evidence to an outage; the host page shows it.
- **Launch note:** until member erasure task 2.1 ships, DorkOS mirrors keep the text of a taken-down message (never its files). The redaction feed is therefore needed before a hosted launch if taken-down text must leave members' machines; this spec flags it rather than changing erasure's phasing.

## Documentation

- `apps/community/OPERATIONS.md`: when and how to take down, the scope, evidence store setup (put-only credentials, object lock, separate bucket), reading `record.json`, retention, the reversal window, what members and owners see, `notify: false`.
- `apps/community/API.md`: the host routes, the tenant notices route, the owner deletion status fields, the record schema.
- `apps/community/DEPLOYMENT.md`: the evidence variables and `COMMUNITY_TAKEDOWN_REVERSAL_HOURS`.
- `docs/guides/communities.mdx`: what "removed by the host" means for members.
- Member erasure copy and docs: the added "cannot reach" clause.
- A changelog fragment per phase.

## Implementation Phases

- **Phase 1, task 1.1 — Item takedowns on the server (launch blocker).** After single-delete task 1.1. Migration; scope; evidence sink and config; host routes for entry and file; staging, `evidence_hold`, worker, gates; audits; notices route; owner deletion status fields (null until phase 2); docs. AC-1 to AC-7, AC-11 to AC-14 (item parts).
- **Phase 1, task 1.2 — Host page, notices, and Report on files.** The host page section, owner list, author banner, Report link `attachment` parameter. After 1.1.
- **Phase 2, task 2.1 — Community takedown (launch blocker).** After task 1.1 and export-any-size task 1.2. Migration; community target; reversal; evidence export copy; deletion and erasure gates; the removed-community message; chooser line. AC-8 to AC-10, AC-11 to AC-13 (community parts).

### Landing order with the other hosting gaps

1. Member erasure 1.1 (#2029) and the hold (#2036).
2. `specs/community-single-item-delete/` task 1.1 (creates `content-removal.ts`, including the `host` tombstone and `removed_by='host'`).
3. This spec's phase 1 (reuses it with `holdBlobs`).
4. `specs/community-export-any-size/` task 1.2 (the job and `evidence` scope).
5. This spec's phase 2.

### Backout

- **Phase 1:** revert the code; the migration stays. First let the worker finish every pending evidence copy (or release held blobs with an operations command, `takedowns:release-held`, which queues them for deletion and marks evidence `not_configured`), because old code does not know `evidence_hold`. Removed messages keep their tombstones.
- **Phase 2:** reverse or finish every community takedown first; then revert. Old code sees an ordinary host-requested `deletion_pending`.

## Open Questions

None. Resolved while specifying:

- ~~Two-person rule?~~ (RESOLVED) **Answer:** not now. **Rationale:** it delays removal, which is the purpose; a dedicated scope lets a host restrict takedowns to a reviewed tool. A later host setting can add approval without changing the data model.
- ~~Remove first or copy first?~~ (RESOLVED) **Answer:** hide first, hold the bytes, copy, then delete. **Rationale:** content is never visible while evidence is pending, and never lost to an outage.
- ~~What if no evidence store is configured?~~ (RESOLVED) **Answer:** takedowns still work and purge at once; the host is warned. **Rationale:** removal must never depend on optional infrastructure.
- ~~Include IP addresses?~~ (RESOLVED) **Answer:** only what Better Auth already stores on the author's current sessions, stated as such. **Rationale:** authorities ask for it; the server adds no new logging.
- ~~Undo?~~ (RESOLVED) **Answer:** community takedowns only, within a window, to `suspended`. **Rationale:** nothing is destroyed until then; items are purged at once.
- ~~Tell the uploader?~~ (RESOLVED) **Answer:** yes by default (category and reference), withheld with `notify: false`. **Rationale:** a statement of reasons is expected in many places; some orders forbid it.

## Related ADRs

- `260923-214421` — A host takes down content by id and preserves evidence outside the API (accepted, from this spec; amends `260923-121712` and `260920-201101`)
- `260923-214411` — Removing a message or file tombstones it in place through one shared module
- `260923-214431` — Exports are resumable background jobs (the evidence export)
- `260923-121150` — Host API keys are scoped host credentials that never reach community content
- `260923-121712` — A host hold stops growth without blocking export, and host-started deletion follows only a noticed hold
- `260920-201101` — Separate community retention from permanent tenant deletion

## References

- DOR-2281 — this specification
- `specs/community-host-operator-api/02-specification.md` (P1, hold and host-started deletion, host links)
- `specs/community-member-erasure/02-specification.md` (redaction feed, cannot-reach copy)
- `specs/community-single-item-delete/02-specification.md`, `specs/community-export-any-size/02-specification.md`
- `apps/community/src/routes/host-lifecycle.ts`, `host/authority.ts`, `host/communities.ts`, `deletion-worker.ts`, `erasure.ts`, `storage/`, `config.ts`, `tenant-context.ts`
- 18 U.S.C. § 2258A (reporting and preservation by US providers); Regulation (EU) 2022/2065 (Digital Services Act) Art. 16–17 (notice and action, statement of reasons)
