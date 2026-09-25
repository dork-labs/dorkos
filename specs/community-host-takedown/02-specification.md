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

| Dependency                                                             | Used for                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Host keys and authority (host-operator P1, on `main`)                  | `requireHostAuthority`, `assertHostActor`, `recordHostAudit`, key scopes                               |
| Host hold (#2036, 0014)                                                | `deletion_pending` host requester columns, `deletion_from_state`, host-requested deletion jobs         |
| Member erasure 1.1 (#2029, 0013)                                       | `entry_redactions`, content version, erasure worker (gated here)                                       |
| `specs/community-single-item-delete/` task 1.1                         | `content-removal.ts` (`removeEntry`, `removeAttachment`, `removed_by='host'`, the host tombstone text) |
| `specs/community-export-any-size/` task 1.2                            | phase 2 only: the export job with `scope='evidence'`                                                   |
| Member erasure 2.1 (redaction feed, DOR-2266, a hosted-launch blocker) | DorkOS mirrors replace cached text (not needed for the server-side takedown)                           |
| `@aws-sdk/client-s3` 3.1135.0                                          | the S3 evidence sink (`PutObject` with `ChecksumSHA256` only)                                          |
| `pg` + hand-written SQL migrations                                     | one migration per phase, **the next free number at build time**                                        |

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

**Idempotency is per actor.** The key is unique per `(actor kind, actor id, idempotencyKey)`, so two operators or two keys choosing the same key never collide, and one actor cannot learn of or replay another's takedown by guessing its key.

**Community takedowns are rate limited per actor.** At most `COMMUNITY_TAKEDOWN_COMMUNITIES_PER_DAY` (default 3, range 1 to 100) community takedowns per actor in any rolling 24 hours; the next answers `429 RATE_LIMITED` and writes nothing. Every community takedown, and every refusal by this limit, logs one warning line (`{"event":"community.takedown.community",…}` with ids only) that a host's alerting can watch, and the host page shows the last 7 days of community takedowns at the top. Item takedowns are not limited: removal must never wait.

**Additional routes (same scope unless noted):**

| Route                                                    | Result                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/host/takedowns/:takedownId/evidence/retry` | a `failed` evidence attempt goes back to `pending` (a new evidence export for a community takedown)                                      |
| `POST /api/v1/host/takedowns/:takedownId/release-held`   | **person session and password only, never a key**: releases blobs kept as `held_on_primary` to deletion; audited `takedown.release_held` |

**What a takedown cannot reach by id.** Names are not content items: the community's name and description, channel names and descriptions, and member and agent display names and handles. When one of those is illegal, the host uses a community takedown. The icon can be taken down on its own (`target.kind = 'icon'`).

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
    z.strictObject({ kind: z.literal('icon') }), // the community's icon
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
  // Omitted: false for child_safety, true for every other category. The response carries the value used.
  notify: z.boolean().optional(),
  password: z.string().min(1).optional(), // required for a person, refused for a key
});
/** A takedown as host authority sees it: ids and states only, never content. */
export const CommunityAdminTakedownSchema = z.strictObject({
  id,
  communityId: id,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('entry'), entryId: id }),
    z.strictObject({ kind: z.literal('attachment'), attachmentId: id, entryId: id.nullable() }),
    z.strictObject({ kind: z.literal('icon') }),
    z.strictObject({ kind: z.literal('community') }),
  ]),
  category: CommunityAdminTakedownCategorySchema,
  reference: z.string().nullable(),
  notify: z.boolean(),
  actor: z.strictObject({ kind: z.enum(['person', 'api_key']), id: z.string() }),
  state: z.enum(['active', 'reversed']),
  evidence: z.strictObject({
    state: z.enum([
      'pending',
      'retrying',
      'stored',
      'failed',
      'not_configured',
      'nothing_to_preserve',
      'held_on_primary', // child_safety or legal_order with no store: bytes kept until released
    ]),
    recordSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(), // of record.json, once stored
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
2. Lock the target entry `FOR NO KEY UPDATE` (for a file, lock the attachment row `FOR UPDATE` first and re-read its entry, as `removeAttachment` does; for the icon, lock the community row `FOR UPDATE`). Build the **evidence record** (below) from the rows as they are now. For an entry or file by an agent, the record names the agent **and** its owner member, with the owner's account and sessions, because the agent has no account of its own.
3. Call `removeEntry` or `removeAttachment` from `content-removal.ts` with `removedBy: 'host'` and `holdBlobs: true` (new option): files are detached and their `managed_blobs` rows move to a new state `evidence_hold` instead of `pending_delete`, so the bytes survive but nothing can reach them. With no evidence store configured, `holdBlobs` is false and they go straight to `pending_delete`, **except** for the categories `child_safety` and `legal_order`: then the blobs are still moved to `evidence_hold`, evidence is `held_on_primary`, and they stay until a host operator releases them (`release-held`, person and password) or an evidence store is configured and a retry copies them. Many laws require preserving this material; purging it because a store was not set up would destroy it.
   For `target.kind = 'icon'`: `communities.icon_blob_key` is cleared (the settings version bumps, as removing an icon does today), the icon blob moves to `evidence_hold` or `pending_delete` by the same rules, and no redaction row is written (the icon is not an entry). An entry already removed by its author or a moderator is relabelled to the host tombstone (`removed_by='host'`, one redaction row); an erased entry is left as erased. In both cases the record notes `contentAlreadyRemoved: true` and evidence is `nothing_to_preserve` unless files were still held.
4. Delete every `ready` export in the community and queue its blobs (the helper erasure uses, moved to `content-removal.ts` as `deleteReadyExports`).
5. Insert `community_takedowns` and `takedown_evidence_staging(takedown_id, record jsonb, blob_keys text[])` whenever evidence is not `not_configured` or `nothing_to_preserve`: with a store, **and** whenever evidence is `held_on_primary`. The staged record (text, author, account, sessions, file metadata) is what a later store plus `evidence/retry` writes as `record.json`; without it, a retry could only copy bytes with no account or session details (those may be gone by then).
6. `recordHostAudit` (`takedown.create`, `changed_fields` `{target.kind}`), and a tenant `audit_events` row (`actor_kind='host'`, no member, action `entry.takedown`, `attachment.takedown`, or `icon.takedown`, `subject_id` the target id, `withheld = NOT notify`). A **withheld** tenant audit row (new column `audit_events.withheld boolean NOT NULL DEFAULT false`) is left out of owner exports (both versions) and any owner-facing audit read, so `notify: false` is not undone by an export.

After commit the members, DorkOS, and every route see the tombstone; `GET /attachments/:id` answers `404`; the redaction feed carries the change.

### Community takedown

Allowed from `active`, `archived`, `held`, `suspended`, and `deletion_pending`; `pending_owner` is refused (`409`, abandon it instead). The request carries `lifecycleVersion` and the last eight characters of the community id. One transaction:

1. Lock the community `FOR UPDATE`; check the version and suffix; `assertHostActor`.
2. `revokeTenantAccess` (every grant, agent credential, invitation, pairing, pending admission).
3. Set `lifecycle='deletion_pending'`, `delete_requested_by_host_actor`, `delete_requested_by=NULL`, `takedown_id`, and `delete_after = now() + COMMUNITY_TAKEDOWN_REVERSAL_HOURS` (default 72, **range 24 to 720**: never less than a day, so a mistaken or malicious takedown can always be reversed). The existing check `communities_deletion_state` requires `delete_after = delete_requested_at + interval '7 days'`; the phase 2 migration relaxes it to that equality **or** `takedown_id IS NOT NULL AND delete_after >= delete_requested_at + interval '24 hours'`. The takedown row stores `prior_state` (the lifecycle, `suspended_from_state`, `held_from_state`, `deletion_from_state`, `deletion_from_prior_state`, and who requested any pending deletion) for reversal. `deletion_from_state` records the prior state (`active`, `archived`, `held`, or `suspended`, with `deletion_from_prior_state` as the hold spec defines); from an owner-requested `deletion_pending` the existing origin columns stay and the job's requester becomes the host, so the owner can no longer cancel. Upsert `community_deletion_jobs` with the host requester, `takedown_id`, and `delete_after`.
4. Delete every ready export; cancel open export jobs other than the evidence one.
5. Insert `community_takedowns`. With no store and category `child_safety` or `legal_order`, evidence is `held_on_primary`: no evidence export runs, the community's rows and blobs stay (deletion is blocked, below) until a person releases it with `release-held` (password) or a store is configured and `evidence/retry` starts the evidence export and copies it. With no store and any other category, evidence is `not_configured`. When a store is configured, insert an export job with `scope='evidence'` (`specs/community-export-any-size/`, "Evidence scope": authority is this takedown row, any lifecycle while the community exists, reservations with the `evidence` option, never downloadable, manifest lifecycle = the state before the takedown), else evidence is `not_configured`. In the same transaction, stage into `takedown_evidence_staging.record` every member's account details that the archive cannot hold: for each member row with an account, the account id, email, account creation time, and each current session's `createdAt`, `ipAddress`, and `userAgent`. These go into `record.json` as `accounts`, so an account erasure or sign-out later cannot remove them from the evidence.
6. Host audit `takedown.create`.

Members and every installation get `423 COMMUNITY_DELETION_PENDING` with the message "This community was removed by its host." (`tenant-context.ts` reads `takedown_id`). The owner cannot export or cancel.

**Reversal.** `POST /host/takedowns/:id/reverse` is allowed only for a community takedown, while its deletion job is `waiting` and `delete_after` has not passed, and only when the takedown did not start from an **owner-requested** deletion (the host cannot restore an owner's own deletion; `409`). It sets `lifecycle='suspended'` and chooses `suspended_from_state` from the stored `prior_state`:

| State before the takedown                                                                | After reversal                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`, `archived`, or `held`                                                          | `suspended`, `suspended_from_state` = that state; `held_from_state` kept when it was `held`                                                                                                                                                                                |
| `suspended` (from X)                                                                     | `suspended`, `suspended_from_state` = X; `held_from_state` kept when X is `held`                                                                                                                                                                                           |
| `deletion_pending` started by the **host** (from `held`, or from a suspension of a hold) | `suspended`, `suspended_from_state` = `held` (the `deletion_from_state`, or `deletion_from_prior_state` when that was `suspended`), `held_from_state` kept. The host's own earlier deletion request is cancelled with it; the host may request it again after a new notice |
| `deletion_pending` started by the **owner**                                              | refused, `409`                                                                                                                                                                                                                                                             |

Every row satisfies the hold migration's `communities_hold_state` check (which keeps `held_from_state` set while suspended from a hold). It clears the deletion columns and `takedown_id`, deletes the job, marks the takedown `reversed`, and audits `takedown.reverse`. Credentials stay revoked; the host resumes the community when it is ready. **A reversal does not stop evidence:** an evidence export in progress finishes, is copied, and evidence becomes `stored` on the reversed takedown (the export worker checks only that the takedown row exists). Item takedowns cannot be reversed (`409`): their content is gone.

### Evidence

**The store.** Configured by a second, independent set of variables; all optional, validated in `parseConfig` like the primary store:

| Variable                                                                                                  | Meaning                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMUNITY_EVIDENCE_DRIVER`                                                                               | `filesystem` or `s3`; unset means no evidence store                                                                                                                                                              |
| `COMMUNITY_EVIDENCE_PATH`                                                                                 | absolute; must not equal, contain, or sit inside `COMMUNITY_STORAGE_PATH`, the directory the server serves its web app from, the operating system's temporary directory, or any staging directory the stores use |
| `COMMUNITY_EVIDENCE_S3_BUCKET`, `_REGION`, `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_PREFIX` | as the primary S3 settings; bucket plus endpoint must differ from the primary's                                                                                                                                  |

`src/evidence/sink.ts` exposes one operation, `put(path, source, { sha256, byteSize })`. The S3 sink sends `PutObject` with `ChecksumSHA256` and `If-None-Match: *` and never calls `GetObject`, `ListObjects`, `HeadObject`, or `DeleteObject`, so the host can (and the operations guide says it should) give the server a put-only credential and turn on object lock. Not every S3-compatible store honours `If-None-Match` on `PutObject` (some ignore it silently), so the guide says object lock (or a bucket policy that denies overwrites) is what actually prevents overwriting, and the conditional header is a second line. The filesystem sink writes a temporary name `.tmp-<random>` opened with `wx` in the target directory, `fsync`s it, then `link()`s it to the final name, which fails with `EEXIST` rather than replace an existing file (a `rename` would silently overwrite), then `unlink()`s the temporary name and `fsync`s the directory. At startup it removes its own `.tmp-*` files older than an hour (the only files it ever deletes); the S3 sink's local staging directory is swept like the primary store's. Paths are server-built: `takedowns/<takedownId>/attempt-<n>/…`. The sink stages through local disk exactly as the primary store does (at most one file or one archive segment at a time).

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
- for a community: `accounts` (staged at takedown time, above);
- `notes`: "The Community server does not log request IP addresses; session IP addresses are those the sign-in stored."

Once `record.json` is written, its SHA-256 is stored as `community_takedowns.evidence_record_sha256` and in a host audit row `takedown.evidence_stored` (new nullable column `host_audit_events.evidence_record_sha256`), so a later copy of the evidence can be checked against the server's own record.

**The worker** (`src/takedown-worker.ts`, started from `main.ts`) claims a takedown whose evidence is `pending` or `retrying` and due, with `FOR UPDATE SKIP LOCKED` and a 5-minute lease, and runs attempt `n = attempts + 1`:

- **Item:** stream each held blob from the primary store into the sink, computing SHA-256 and comparing it with the file's stored checksum; then write `record.json` (the staged record plus the file hashes and paths). In one transaction: delete the staging row, move the held blobs to `pending_delete` with `pending_blob_deletions` rows, set evidence `stored` with its location.
- **Community:** wait until the evidence export is `ready` (or `failed`, which fails the attempt), then stream each segment into `archive.zip.NNNNNN`, write `record.json`, set evidence `stored`, and queue the evidence export's segments for deletion.
- **Failure:** increment `attempts`, record an error class (never a message), set `retrying`, back off with the existing cleanup backoff (capped at one hour). Log every failure. The host page shows it. For a community takedown whose evidence export **failed**, the worker creates a new evidence export job automatically, up to 5 times; after that the evidence is `failed` and waits for `evidence/retry` (or the offline command `takedowns:evidence-retry <id>`).
- **Age alert:** while evidence is `pending`, `retrying`, `failed`, or `held_on_primary` for longer than `COMMUNITY_TAKEDOWN_EVIDENCE_ALERT_HOURS` (default 6), the worker logs one warning line per hour per takedown (`{"event":"community.takedown.evidence_overdue",…}`, ids only) and the host page marks it.

**Gates.** While any takedown in a community has evidence `pending`, `retrying`, `failed`, or `held_on_primary`:

- the tenant deletion worker skips that community, **whoever requested the deletion**: an owner's own request, a host-started deletion after a hold, or the community takedown itself. The deletion job stays `waiting` and runs once evidence is `stored` (or released to `not_configured`) and `delete_after` has passed. So a takedown's preserved material is never destroyed by a deletion racing it;
- for a community takedown, the erasure worker skips membership erasures in that community **and account erasures of any account with a membership there**, so the evidence archive is what was there at the takedown (an account erasure would husk that member's rows in the community before the evidence export reads them). Account details are also staged at takedown time, above. (Item takedowns need no erasure gate: their record and bytes are already staged apart from the member's rows, and erasure never touches `evidence_hold` blobs.)
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
- **`notify: false`** hides the takedown from both routes and from the owner's deletion status, and its tenant audit row is `withheld` (left out of owner exports); the tombstone and the removal message still show, because content cannot be both gone and unexplained. The host audit records `notify`.
- **Defaults.** When the request omits `notify`, it is `false` for `child_safety` (telling the uploader can tip off someone under investigation) and `true` for every other category. The host page's checkbox follows the chosen category.

### Report link: files

The host-links Report item on a file adds `&attachment=<uuid>` beside the community and entry UUIDs, so a host can take down one file (host-operator task 6.1; done here if 6.1 has landed, otherwise added to 6.1's description).

### Propagation

Item takedowns write `entry_redactions` rows through `content-removal.ts`, so the redaction feed (member erasure task 2.1) carries the host tombstone to DorkOS mirrors and to open browser tabs (`specs/community-single-item-delete/` task 1.3). DorkOS never caches file bytes, so a taken-down file answers `404` to DorkOS at once. Cached **text** leaves mirrors through the redaction feed, which is why member erasure task 2.1 (DOR-2266) is now a hosted-launch blocker (see Security). Ready exports deleted by a takedown also stop any download in progress within 16 MiB (`specs/community-export-any-size/`). A community takedown revokes every credential, so installations stop reading at once; their existing mirrors are not rewritten.

### Data model changes

**Phase 1 migration (next free number at build time):**

- `host_api_keys_scopes`: `cardinality(scopes) BETWEEN 1 AND 5` and the subset gains `communities:takedown`.
- `audit_events_actor_kind`: `IN ('member','system','host')`. Any export manifest schema that enumerates an audit row's `actor_kind` (`CommunityExportManifestV1Schema` once import lands, and version 2's audit row schema) accepts `host` too, so an owner export made after a takedown still imports.
- `managed_blobs` state check gains `evidence_hold` (metadata rule as `committed`: size and checksum set). `managed_blobs_commit_timestamp` (from 0005: `committed_at IS NULL OR state IN ('committed','pending_delete')`) is amended to allow `evidence_hold`, because held blobs were committed before.
- `audit_events.withheld boolean NOT NULL DEFAULT false`; `host_audit_events.evidence_record_sha256 text NULL CHECK (~ '^[a-f0-9]{64}$')`.
- `community_takedowns(id uuid PK, community_id uuid NOT NULL, target_kind CHECK IN ('entry','attachment','icon','community'), entry_id uuid NULL, attachment_id uuid NULL, category CHECK IN (…four…), reference text NULL CHECK (~ '^[A-Za-z0-9._:-]{1,64}$'), notify bool NOT NULL, actor_kind CHECK IN ('person','api_key'), actor_user_id text NULL, actor_api_key_id uuid NULL, idempotency_key text NOT NULL, payload_hash text, UNIQUE (actor_kind, COALESCE(actor_user_id, actor_api_key_id::text), idempotency_key) (as a unique index), state CHECK IN ('active','reversed'), evidence_state CHECK IN ('pending','retrying','stored','failed','not_configured','nothing_to_preserve','held_on_primary'), evidence_location text NULL, evidence_record_sha256 text NULL, evidence_attempts int NOT NULL DEFAULT 0, prior_state jsonb NULL, next_attempt_at timestamptz, lease_until timestamptz, last_error_class text NULL CHECK (~ '^[A-Z][A-Z0-9_]{0,63}$'), created_at, reversed_at)` with target-shape and exactly-one-actor checks. **No foreign key to `communities`**: the record outlives a deleted community (it holds ids and categories only; the operations guide says how long to keep it).
- `takedown_evidence_staging(takedown_id uuid PK REFERENCES community_takedowns(id), record jsonb NOT NULL, blob_keys text[] NOT NULL)`.
- **Phase 2 migration:** `communities.takedown_id uuid NULL`, `community_deletion_jobs.takedown_id uuid NULL`; the evidence export's link `community_takedowns.evidence_export_id uuid NULL`; `communities_deletion_state` relaxed as above (the 7-day equality, or `takedown_id IS NOT NULL AND delete_after >= delete_requested_at + interval '24 hours'`).
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

- **Host page** (`/host`, per community): a **Take down** section: target (message id, file id, or the whole community), category, optional reference, "Tell the owner and the author" (unchecked for `child_safety`, checked for other categories), password for a person, and for a community the id suffix. A warning above it when no evidence store is set: "Takedowns won't keep a copy for the authorities. Set an evidence store first if you need one." The "Tell the owner and the author" checkbox is unchecked when the category is `child_safety` and checked otherwise. A list of takedowns with target (message, file, icon, community), category, time, and evidence state ("Copy saved", "Saving the copy…", "Couldn't save the copy yet; retrying", "Couldn't save the copy" with **Try again**, "No evidence store", "Nothing left to save", "Kept on this server until you release it" with **Release** for a person), an overdue mark, and **Reverse** on a community takedown during its window. Community takedowns from the last 7 days are listed at the top. The host never sees content here.
- **Members:** the tombstone in place of a message; a file gone from its message; "This community was removed by its host." for a community.
- **Owner:** Settings → "Removed by the host": date, what (message or file), channel, reason sentence, reference. For a community takedown, the chooser line above.
- **Author:** a one-time banner per takedown with the reason sentence.

## Testing Strategy

Integration tests on real PostgreSQL with both BlobStores, a filesystem evidence sink, and an S3 evidence sink stub that records calls and throws on anything but `PutObject`. Each test has a purpose comment.

### Acceptance criteria that discriminate

- **AC-1 — No content through the API.** For every takedown route and response (create, replay, list, get, reverse, and the error paths), a JSON key and value scan finds none of the seeded canaries (message text, file name, file bytes' hash, author name, handle, email). The adversarial matrix of host-operator P1 still passes with a key holding all five scopes (every content route `401`).
- **AC-2 — Authority.** A key without `communities:takedown` gets `403` and no row changes; a person without a password gets `403 REAUTH_REQUIRED`; a revoked key racing a takedown on the lock (hook) fails `401` with nothing changed; a key cannot issue keys with the new scope (key management stays session-only).
- **AC-3 — Item takedown hides at once.** After `POST …/takedowns` for entry E (text `canary-text`, one file `canary.txt`): history shows E with `This message was removed by the host.`, `mentions: []`, `attachments: []`, strict-schema valid; `GET /attachments/<id>` is `404` for every credential; the redaction feed lists E; a ready owner export made before is gone (`404`, blobs queued); one `host_audit_events` row and one tenant `audit_events` row with `actor_kind='host'`.
- **AC-4 — Evidence is complete, then primary is clean.** With the filesystem sink: `takedowns/<id>/attempt-1/record.json` exists and parses with `CommunityEvidenceRecordV1`; it holds the text, the author's name, handle, email, and session IP and user agent (for an agent's message: the agent and its owner's account and sessions); `files/<id>` hashes to the original checksum; `evidence_record_sha256` on the takedown and on the `takedown.evidence_stored` host audit row equals the file's SHA-256. The sink refuses to replace an existing file (a pre-created `record.json` at the target makes the attempt fail with `EEXIST`, the existing file untouched). The canary scan below also covers the local staging directories of both stores and the sink (temporary files included). After the blob sweep, the AC-1 canary scan over every column in the `public` schema (from `information_schema.columns`) and every primary store object finds none of the canaries (the evidence directory is excluded and asserted separately). Fails if the copy is partial or primary keeps anything.
- **AC-5 — Store down.** With the sink failing: E is hidden immediately (AC-3 holds); its blob stays in the primary store with state `evidence_hold`; evidence goes `retrying` with an error class; the pending-deletion sweep leaves the blob; the tenant deletion worker skips the community. When the sink recovers: `attempt-2/record.json` is written, the blob is released and swept. The S3 stub recorded only `PutObject` calls.
- **AC-6 — No store configured.** For `illegal_content` and `terms_violation`: evidence is `not_configured`, blobs go straight to `pending_delete`, the host page shows the warning. For `child_safety` and `legal_order`: blobs are `evidence_hold`, evidence is `held_on_primary`, the sweep leaves them, the overdue alert logs after `COMMUNITY_TAKEDOWN_EVIDENCE_ALERT_HOURS` (clock); `release-held` with a key answers `403`, with a person and no password `403 REAUTH_REQUIRED`, with a person and password releases them (swept, audited); configuring a store and calling `evidence/retry` instead copies them and then releases them.
- **AC-6c — Deletion waits for evidence.** In community A with an item takedown whose evidence is `failed` (hook) and, separately, `held_on_primary`: (i) the owner requests deletion and the seven days pass (clock): the deletion worker does not delete A; (ii) a host-started deletion from a noticed hold, past its seven days: not deleted either. After `evidence/retry` succeeds (or a person releases the held bytes), the pending deletion runs. Fails if any requester's deletion outruns the evidence.
- **AC-6d — Held record is staged.** A `child_safety` item takedown with no store stages the full record (text, author, account, sessions, file metadata) in `takedown_evidence_staging`; the author then erases their account; a store is configured and `evidence/retry` writes `record.json` still holding the staged account email and sessions and the held file bytes.
- **AC-6b — Defaults and icon.** A `child_safety` request without `notify` stores `notify=false`, and its tenant audit row is `withheld`; an `illegal_content` request without it stores `true`. An `icon` takedown clears the icon (`GET /icon` answers `404` for members), holds or queues its blob, writes no redaction row, and preserves the icon bytes as evidence.
- **AC-7 — Already removed.** Taking down an entry its author deleted relabels it to the host tombstone (one redaction row) and records `nothing_to_preserve` with `contentAlreadyRemoved: true`; an erased entry stays erased.
- **AC-8 — Community takedown.** The row passes the relaxed `communities_deletion_state` check with `delete_after` 72 hours out (and a direct insert with 23 hours fails it). `record.json` has `accounts` for every member with an account, including emails and session details. The evidence manifest's `community.lifecycle` is the state before the takedown (`held` for a held community) and an owner-scope manifest with `held` fails its schema. From each of `active`, `archived`, `held`, `suspended`: every grant, agent credential, invitation, and pairing is revoked in the same transaction; members get `423` with "This community was removed by its host."; the owner cannot export (`423`) or cancel; the evidence export runs in `deletion_pending`; its segments land in the sink with `record.json`, and concatenated they open as a zip whose manifest is version 2 with `scope: 'evidence'` and counts equal to the community's; the deletion worker waits for both `delete_after` and evidence, then deletes the community. From `pending_owner`: `409`. Wrong suffix or stale version: `409`, nothing changed.
- **AC-8b — Whole-community hold without a store.** A `child_safety` community takedown with no store: evidence `held_on_primary`, no evidence export, account details staged, `delete_after` passes and the community is **not** deleted; `release-held` by a key answers `403`, by a person without a password `403 REAUTH_REQUIRED`; with a password, evidence becomes `not_configured` and the deletion runs. Separately, configuring a store and calling `evidence/retry` runs the evidence export, stores it, and then the deletion runs. A `terms_violation` community takedown with no store is `not_configured` and deletes after `delete_after`.
- **AC-9 — Reversal.** Within the window the host reverses: lifecycle `suspended` with `suspended_from_state` per the reversal table for each starting state (`active`, `archived`, `held`, `suspended` from `held`, and a host-started `deletion_pending` from `held` → `suspended` from `held` with `held_from_state` kept), every lifecycle check passing, credentials still revoked, the deletion job gone, stored evidence untouched; a reversal while the evidence export is still building leaves it running, and evidence ends `stored` on the reversed takedown; after `delete_after` or once deletion started: `409`. Reversing an item takedown: `409`. A takedown of an owner-requested deletion cannot be reversed (`409`), and the owner can no longer cancel it.
- **AC-10 — Erasure waits for community evidence.** An erasure of member P scheduled before a community takedown comes due while evidence is pending: the erasure worker does not run it, and an **account** erasure of another member Q (whose account also belongs to community B) does not run either; after evidence is stored both run; after evidence is stored it runs (and the community is later deleted anyway). The evidence archive contains P's messages.
- **AC-11 — Notices.** With `notify: true`: the owner's list shows the item takedown with the category sentence and reference, the author sees their banner, another member sees nothing; the owner's deletion status shows `requestedBy: 'host'` and the takedown. With `notify: false`: all of them show nothing, the tombstone still shows, the host audit row records `notify=false`, and an owner export made afterwards contains no audit row for the takedown (the row is `withheld`).
- **AC-12 — Isolation.** Community B's rows, blobs, and exports are unchanged by every takedown in A.
- **AC-13 — Idempotency and rate.** Replaying a takedown request returns the same takedown with `200` and no second removal, audit row, or evidence attempt; the same key with a different target is `409 IDEMPOTENCY_CONFLICT`; the same key used by a different actor creates a separate takedown. A fourth community takedown by one key within 24 hours (default limit) answers `429` and writes nothing, and each community takedown and the refusal write one warning log line; `COMMUNITY_TAKEDOWN_REVERSAL_HOURS=23` fails configuration parsing.
- **AC-13b — Evidence retries.** A community takedown whose evidence export fails (hook) gets a new evidence export automatically, up to 5 times, then evidence `failed`; `evidence/retry` starts it again and it ends `stored`. Evidence pending longer than the alert hours logs one overdue line per hour.
- **AC-14 — Config.** An evidence path equal to, containing, or inside the primary storage path, the served web-app directory, the temporary directory, or a store staging directory, or the same bucket and endpoint as the primary, fails configuration parsing with a clear message. A `.tmp-*` file older than an hour in the evidence directory is removed at startup; a final file is never removed.
- **AC-15 — Migration.** A blob moved to `evidence_hold` keeps its `committed_at` and passes the amended `managed_blobs_commit_timestamp` check.

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
- **Launch dependency:** until member erasure task 2.1 (the redaction feed, DOR-2266) ships, DorkOS mirrors keep the text of a taken-down message (never its files). That task is therefore a hosted-launch blocker (decided 2026-09-23; the erasure spec now says so), and it is built after `specs/community-single-item-delete/` task 1.1, whose bump-before-insert order its cursor relies on.
- **Held illegal material without a store.** For `child_safety` and `legal_order`, bytes stay on primary storage (unreachable through any route) until an operator releases them or a store is configured. The host page and the overdue alert keep that visible.
- **Rate and reversal floor.** A leaked takedown key can take down at most `COMMUNITY_TAKEDOWN_COMMUNITIES_PER_DAY` communities a day, each reversible for at least 24 hours, and every one raises a warning log line.

## Documentation

- `apps/community/OPERATIONS.md`: when and how to take down, the scope, evidence store setup (put-only credentials, object lock, separate bucket), reading `record.json`, retention, the reversal window, what members and owners see, `notify: false`.
- `apps/community/API.md`: the host routes, the tenant notices route, the owner deletion status fields, the record schema.
- `apps/community/DEPLOYMENT.md`: the evidence variables, `COMMUNITY_TAKEDOWN_REVERSAL_HOURS` (24 to 720), `COMMUNITY_TAKEDOWN_COMMUNITIES_PER_DAY`, `COMMUNITY_TAKEDOWN_EVIDENCE_ALERT_HOURS`, the log lines to alert on, and the offline commands `takedowns:evidence-retry` and `takedowns:release-held`.
- `docs/guides/communities.mdx`: what "removed by the host" means for members.
- Member erasure copy and docs: the added "cannot reach" clause.
- A changelog fragment per phase.

## Implementation Phases

- **Phase 1, task 1.1 — Item takedowns on the server (launch blocker).** After single-delete task 1.1. Migration; scope; evidence sink and config; host routes for entry and file; staging, `evidence_hold`, worker, gates; audits; notices route; owner deletion status fields (null until phase 2); docs. AC-1 to AC-7, AC-6b, AC-11 to AC-15, AC-13b (item parts).
- **Phase 1, task 1.2 — Host page, notices, and Report on files.** The host page section, owner list, author banner, Report link `attachment` parameter. After 1.1.
- **Phase 2, task 2.1 — Community takedown (launch blocker).** After task 1.1 and export-any-size task 1.2. Migration; community target; reversal; evidence export copy; deletion and erasure gates; the removed-community message; chooser line. AC-8 to AC-10, AC-11 to AC-13b (community parts).

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

- **Content removed before its takedown (decided during task 1.1 review, 2026-09-24).** A takedown of a message its author or an admin already removed holds again that message's files whose bytes the cleanup sweep has not deleted yet (a `removed_file_blobs` row describes each until the sweep) and copies them as evidence, instead of `nothing_to_preserve`. **Residual gap, open:** files the sweep already deleted, and the removed message's original text (replaced in place by the tombstone at removal), are gone; the record says `contentAlreadyRemoved: true`. Keeping them would mean retaining removed content for every removal just in case, which the single-item delete promise rules out.

Resolved while specifying:

- ~~Two-person rule?~~ (RESOLVED) **Answer:** not now. **Rationale:** it delays removal, which is the purpose; a dedicated scope lets a host restrict takedowns to a reviewed tool. A later host setting can add approval without changing the data model.
- ~~Remove first or copy first?~~ (RESOLVED) **Answer:** hide first, hold the bytes, copy, then delete. **Rationale:** content is never visible while evidence is pending, and never lost to an outage.
- ~~What if no evidence store is configured?~~ (RESOLVED) **Answer:** takedowns still work. For `illegal_content` and `terms_violation` the bytes are purged at once; for `child_safety` and `legal_order` they are kept unreachable on primary storage until a host operator releases them or a store copies them (coordinator decision, 2026-09-23). The host is warned. **Rationale:** removal must never depend on optional infrastructure, and material the law requires preserving must not be destroyed because a store was missing.
- ~~Include IP addresses?~~ (RESOLVED) **Answer:** only what Better Auth already stores on the author's current sessions, stated as such. **Rationale:** authorities ask for it; the server adds no new logging.
- ~~Undo?~~ (RESOLVED) **Answer:** community takedowns only, within a window of at least 24 hours (default 72), to `suspended`; community takedowns are also rate limited per actor with a warning log line each (coordinator decision, 2026-09-23). **Rationale:** nothing is destroyed until then, and a leaked key cannot quietly remove many communities; items are purged at once.
- ~~Tell the uploader?~~ (RESOLVED) **Answer:** yes by default (category and reference), except `child_safety`, which defaults to not telling (coordinator decision, 2026-09-23); `notify` overrides either way, and a withheld takedown's tenant audit row is left out of owner exports. **Rationale:** a statement of reasons is expected in many places; telling a suspected abuser can tip them off.

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
