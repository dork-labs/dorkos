---
slug: community-member-erasure
number: 260923-134613
created: 2026-09-23
status: specified
linear-issue: DOR-2247
project: Cloud-Hosted Communities
---

# Community member erasure

**Status:** Approved
**Author:** Claude (for DOR-2247)
**Date:** 2026-09-23

## Overview

A person on a Community host can erase themselves from one community, or delete their account and be erased from every community on the host. After a 72-hour window in which they can cancel, the server removes their name, handle, account link, messages, files, agents, and connections, and rewrites mentions of them in other people's messages. Their messages stay in place in threads as `This message was erased.` so conversations keep their shape. Every live export in the community is deleted.

Phase 1 task 1.1 and phase 2 task 2.1 are both hosted-community launch blockers (task 2.1 since 2026-09-23: a host takedown, `specs/community-host-takedown/`, must also leave members' DorkOS copies). Two more tasks follow: the community owner erasing a former member, including an imported historical member (task 1.2, after import exists), and a content-free redaction feed that lets DorkOS installations replace their cached copies (task 2.1).

Erasure belongs to the person and to the community owner. Host authority (a host operator's session or a host API key) cannot request, cancel, speed up, or observe one. This keeps the rule from the host-operator API spec (its Open Question 7) and ADR `260920-201101`: host authority never reads or writes community content.

## Background / Problem Statement

- Leave and removal (`routes/members.ts`, `remove()`) end access and revoke credentials, but keep `members.display_name`, `members.handle`, `members.user_id`, every entry with its `author_display_name`, every attachment, and every mention. The leave screen says so: "Your past messages stay attributed to you."
- Entries are immutable. There is no edit or delete route, so there is no edit history to erase. There are no reaction or notification tables; unread state is `read_cursors`.
- A host account cannot be closed. Better Auth's `user.deleteUser` is not enabled in `auth.ts`, and five columns reference `"user"(id)` without a cascade (`members.user_id`, `invite_uses.user_id`, `host_operators.user_id`, `host_audit_events.actor_user_id`, `bootstrap_grants.revoked_by`), so a delete would fail anyway. (The host-operator API spec says accounts "can already be closed through Better Auth". That is not true today; this spec closes the gap.)
- Owner exports copy every member's email and every message into a zip that lives for an hour. Each member's DorkOS installation keeps a persisted mirror of the rooms it reads (`apps/server/src/services/communities/remote/mirror-store.ts`), indexed by DorkOS message search, and a member's local agents may have saved what they read.
- A host that serves people in the EU or California will receive erasure requests (GDPR Art. 17, CCPA deletion). Without this, hosted communities cannot launch.

## Goals

- A person can erase themselves from one community (including one they already left), or delete their account and be erased everywhere on the host, without anyone's help.
- After erasure, no row, column, blob, export, or log line on the Community server holds the person's name, handle, email, account link, message text, file names, file bytes, or hashes of them, except the leftovers this spec names.
- Other people's history stays readable: threads, replies, sequence numbers, read positions, and cursors keep working.
- One 72-hour cancellable window, with nothing changed until it runs.
- No change to any existing wire object or SSE event, so every DorkOS installation keeps working.
- The UI tells the truth about what erasure cannot reach.

## Non-Goals

- Any erasure started, cancelled, sped up, or read by host authority. A host that gets an emailed request uses the existing offline password recovery (`src/recover-password.ts`) so the person can sign in and erase themselves.
- In phase 1: the owner erasing someone else. That is task 1.2.
- In phase 1: the redaction feed route and DorkOS mirror changes. That is task 2.1. Phase 1 only writes `entry_redactions` rows so 2.1 can catch up on every earlier erasure.
- Admins erasing anyone other than themselves.
- Deleting or editing single messages, for moderation or otherwise.
- Finding a person's name, words, or likeness in free text, code, or files posted by other people or their agents. Only `@handle` mentions outside code and quotes are rewritten.
- Channel names, channel descriptions, and the community icon, even when the person set them. They are community settings, not attributed to anyone in the database.
- Recalling copies on other people's computers (downloaded exports, DorkOS mirrors, anything a member's agents saved) or reaching the host's backups directly.
- Legal holds. The server has none.
- A wire flag that lets clients style tombstones differently. It would change `CommunityWireEntrySchema`, which is strict. Follow-up with the next wire version.
- Closing an account that has ever been a host operator online (see Security). Follow-up: an offline host command.
- Time or effort estimates.

## Technical Dependencies

| Dependency                         | Version in repo              | Used for                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hono`                             | 4.13.8                       | routes                                                                                                                                                                                                                                                   |
| `better-auth`                      | 1.7.5                        | `verifyPassword` reauthentication; session age for fresh-sign-in reauthentication; `databaseHooks.session.create.before` refusing any new session while an account erasure runs. `deleteUser` stays disabled: the server deletes the account rows itself |
| `pg` + hand-written SQL migrations | `apps/community/migrations/` | one new migration, **the next free number at build time** (the host-operator API spec takes 0012 to 0015), added to the list in `src/migrate.ts`                                                                                                         |
| `drizzle-orm`                      | 0.45.2                       | `src/schema.ts` mirrors the migration                                                                                                                                                                                                                    |
| `zod`                              | ^4.1.13                      | new strict schemas in `@dorkos/shared/community-wire`                                                                                                                                                                                                    |
| Node `crypto`                      | built in                     | random husk handles, SHA-256 of tombstone payloads                                                                                                                                                                                                       |

No new runtime dependency.

## Detailed Design

### Shared rules

- **Who (phase 1).** Only the person, through a signed-in browser session for their own account. Every erasure route refuses a bearer credential of any kind (connection grant, agent credential, host API key) with `403 FORBIDDEN`. Host authority has no route here: account routes act only on the signed-in account's own memberships and requests. A host operator who is also a member erases their own membership like anyone else (their account is a separate matter; see Security).
- **Reauthentication.** Password when the account has a `credential` account row (`auth.api.verifyPassword`); otherwise the request's session must have been created less than 5 minutes ago, or the route answers `403 REAUTH_REQUIRED` with "Sign in again, then try once more."
- **Window.** Every request is `scheduled` with `execute_after = created_at + 72 hours` (a constant, `ERASURE_WINDOW_HOURS`, not configuration). Nothing about the person changes until it runs. The person can cancel until then; after `execute_after`, cancel answers `409 STATE_CONFLICT`.
- **Every lifecycle.** Requests are accepted and erasures run in `active`, `archived`, `held`, `suspended`, and `deletion_pending`. In `held` and `archived` erasure is removal, not growth; the host-operator spec's hold rules list it as allowed.
- **Idempotent by member id.** The procedure can be re-run on any member id at any point and converges to the same final state. That makes worker restarts, backup re-application, and overlapping requests safe.
- **Tenant first.** Every step names `community_id` in its predicate and locks. Erasing one person never touches another community's rows.
- **Error codes.** One new code, `REAUTH_REQUIRED`, added to `CommunityWireErrorCodeSchema` (only the same-origin browser bundle and the community app parse that enum). Everything else reuses `FORBIDDEN`, `NOT_FOUND`, `STATE_CONFLICT`.

### What a thread shows

An erased entry keeps `id`, `channel_id`, `seq`, `parent_entry_id`, `thread_root_entry_id`, `created_at`, and its author id (now the husk's), so replies, thread roots, cursors, and unread counts are unchanged.

| Column                | After erasure                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `text`                | `This message was erased.`                                                                                    |
| `author_display_name` | `Erased member` (human) or `Erased agent` (agent)                                                             |
| `idempotency_key`     | `erased:<entry id>`                                                                                           |
| `payload_hash`        | SHA-256 of `{"text":"This message was erased.","mentions":[],"parentEntryId":<unchanged>,"attachmentIds":[]}` |
| `erased_at` (new)     | the time of erasure                                                                                           |
| `entry_mentions` rows | deleted                                                                                                       |
| `attachments` rows    | deleted, blobs to cleanup                                                                                     |

On the wire this is an ordinary `CommunityWireEntry` with that text and name, `mentions: []`, and `attachments: []`. Older DorkOS installations render it with no change. The text is the same whoever asked.

### Mentions in other people's messages

The person's old handle is released at the end (a newcomer may take it), so a leftover `@handle` could later seem to name someone else. For every other entry in the community:

- Delete every `entry_mentions` row whose target is the person's member id or one of their agent ids.
- Rewrite the handle tokens the mention resolver itself would see. `rewriteHandleTokens(text, handles)` in `src/erasure.ts` reuses the tokenizer from `src/mentions.ts` (export its masking and address pattern rather than copying them): it masks fenced code, inline code, and quoted lines exactly as `maskedText` does, finds `@` tokens with the same pattern, applies the resolver's trailing strip (`[.\-_]+$`), and replaces a token only when its stripped handle equals, case-insensitively, one of the person's or their agents' handles, **and** the `@` is at the start of the text or follows a character that is not `[A-Za-z0-9_.-]`. The stripped trailing characters stay. The replacement is `@[erased]`.
- Tokens inside code or quotes, and email-shaped strings (`bob@zq`), are left alone: there they are not mentions, and rewriting them would damage code such as `@types/node` or `@media` when a handle happens to be `types` or `media`. These are named leftovers (AC-10).
- `payload_hash` and `idempotency_key` of other people's entries are **not** changed, so their own retries still replay.

`@[erased]` can never resolve as a mention: the address pattern needs a letter or digit after `@`. Handles are never renamed today, so the current handle is the one used in every past message; a future rename feature must keep past handles for this step.

### The husk

The member row stays, because entries, audit rows, deletion requests, and invites point at it, but it no longer leads to anyone:

- `members`: `display_name = 'Erased member'`, `handle = 'erased-' || 12 random lowercase base32 characters`, `user_id = NULL`, `active = false`, `removed_at = COALESCE(removed_at, now())`, `erased_at = now()`. `role` and `created_at` are kept.
- `community_handles`: the member's row is re-keyed to the new random handle, releasing the old one.
- Each agent the person owns: `display_name = 'Erased agent'`, a random `erased-…` handle (and its `community_handles` row), `local_agent_id = NULL`, `active = false`, `revoked_at = COALESCE(revoked_at, now())`.

### Locking

Posts, reads, and the existing `live()` helper take the `communities` row `FOR SHARE` (`lockActiveCommunity`, `lockChannel` in `src/data.ts`). Erasure must not freeze a community, so:

- Every erasure transaction takes the `communities` row `FOR SHARE` (so a lifecycle change waits for it, and posts do not), then the member row `FOR UPDATE`.
- Candidate rows are found **without** a lock (plain `SELECT id … LIMIT 500`), then each batch of at most 500 rows is locked `FOR NO KEY UPDATE` by id and re-checked before it is changed. Not `FOR UPDATE`: a reply takes `FOR KEY SHARE` on its parent through the parent foreign key while holding its channel `FOR UPDATE` (`lockChannel`, `data.ts`), so `FOR UPDATE` on the parent could deadlock with it. Erasure never changes an entry's key.
- The content version lives in its own table, `community_content_versions(community_id PK, version)`, so bumping it contends only with export commits, never with posts.
- Step 5 records a per-channel watermark (`max(seq)` per channel) when it starts; the seal step only scans entries above that watermark.

### The procedure (one membership)

`eraseMembership(communityId, memberId)` in `src/erasure.ts`:

1. **End access.** If the member is active, run the existing `remove()` with action `member.erase.start` (it revokes agents, credentials, grants, and pairings and deletes channel memberships, read cursors, and admission receipts). Then delete outright: the member's `connection_grants` and `connection_pairings` rows (approved or declined; see Pairings below), their agents' `agent_credentials`, `agent_channel_members` for their agents, `owner_quota_windows`, and for this community the `invite_uses`, `pending_admissions`, and `admission_receipts` rows for the member's `user_id` (read before the husk step nulls it). Revoke the member's unexpired invites (`revoked_at = now()`), keeping the rows.
2. **Files.** Delete every `attachments` row uploaded by the member or their agents, bound or unbound, and in the same transaction move each blob to cleanup: `UPDATE managed_blobs SET state='pending_delete' … WHERE state IN ('committed','stored')` plus a `pending_blob_deletions` row, the same two statements `queueCommittedBlobDeletion` and `discardManagedBlob` run (`storage/managed-blobs.ts`; `discardManagedBlob` itself takes a pool and deletes from the store, so it is not called here). For each deleted attachment that was bound to an entry, the same transaction first bumps the content version and then inserts one `entry_redactions` row for that entry (its file list changed); unbound uploads get no row (amended 2026-09-23, `specs/community-single-item-delete/`). A reservation not yet committed has no uploader column and no `attachments` row; if its upload commits later, the seal step catches it, and the attachment route refuses a commit for a principal that is no longer active.
3. **Exports.** Bump the community's content version, then, for every `export_archives` row in the community with `state='ready'` and `deleted_at IS NULL`, queue its blob and every one of its segment blobs (`export_segments`, once `specs/community-export-any-size/` lands) for cleanup **before** deleting the row, since deleting it cascades the segment rows away. Queued and building export jobs are left alone: they rebuild from the redaction rows (amended 2026-09-23). The seal step's leftover check counts only `state='ready'` exports.
4. **Tombstones.** In batches, entries with `erased_at IS NULL` authored by the member or their agents: bump the content version (taking its row lock) **first**, then apply the tombstone table, delete their mention rows, and insert one `entry_redactions` row per entry (order amended 2026-09-23 so redaction ids become visible in commit order; the redaction feed relies on it).
5. **Mentions.** Record the per-channel watermark. In batches, other entries in the community that have a mention row for the person or their agents, or whose `text` contains `@<handle>` for one of them (a case-insensitive `position()` pre-filter; the exact rule runs in code): bump the content version first, then delete those mention rows, apply `rewriteHandleTokens`, and insert one `entry_redactions` row per changed entry (order amended 2026-09-23).
6. **Seal.** Repeat steps 1, 2, and 4 (anything the member or their agents did between steps), step 3, and step 5 above the watermark. Then, in one transaction: apply the husk; write the tenant audit row `member.erase.complete` (`actor_kind='system'`, `subject_id` the husk id, nothing else); mark this membership done. Log one line, `{"event":"community.member_erased","communityId":…,"memberId":…}`, and append the same line to the erasure journal when one is configured (Backup re-application).

The old handle stays in `members.handle` until step 6, so a restart at any point can still find the tokens to rewrite.

A person cannot ask to erase a membership in which they are the active owner (`403 FORBIDDEN`, "Transfer ownership or delete the community first."), matching leave.

### The procedure (whole account)

`eraseAccount(userId)`:

1. **At request.** Refused (`403 FORBIDDEN`) if the account has any `host_operators` row, revoked or not (see Security). Refused (`409 STATE_CONFLICT`) while the person is the owner of any community, in any lifecycle state, naming each one and what to do: transfer ownership, or delete the community and wait until the deletion finishes. (Handling a community already in `deletion_pending` without waiting is task 1.2.)
2. **At claim.** The worker's claiming transaction also deletes every `session` row of the user, so the person is signed out everywhere when the erasure starts. While an account request is `running`, `databaseHooks.session.create.before` in `auth.ts` refuses to create a session for that user id, which covers every sign-in method including Google and GitHub (a request `before` hook sees only the path, not which account an OAuth callback resolves to); invite redemption refuses that account, and owner-claim redemption refuses it.
3. **Memberships.** List every `members` row with this `user_id` (active or not, including ones joined during the window), create one child `membership` request per row (`parent_request_id` = the account request, `execute_after = now()`), and run `eraseMembership` for each. A child whose community was removed by tenant deletion counts as done.
4. **Account.** In one transaction that first locks the `"user"` row `FOR UPDATE`: list memberships again; if any remain linked, run them first and retry this step. Then delete `invite_uses` for the user, `pending_admissions` and `admission_receipts` whose `account_id` is the user, `verification` rows whose `value` is the user id or contains the account email (Better Auth 1.7 stores random identifiers such as `reset-password:<token>` with the user id as the value), and finally the `"user"` row (sessions and linked sign-in accounts cascade). Log `{"event":"community.account_erased","userId":…}` (a random id, not an email) and journal it.

After this, the email address can join again by invitation, as a new person with no link to the old history.

### Guards

- **During the window** (`scheduled`): ownership transfer to the member is refused (`409 STATE_CONFLICT`, "That member is leaving this community."); for an account request, owner-claim redemption by the account is refused.
- **While running**: invite redemption that would reactivate the member row (`routes/invites.ts`, which today sets `active=true` on an existing inactive row) is refused with `409 STATE_CONFLICT` ("This account is being erased here. Try again later."), for any community while an account request runs, and for that community while a membership request runs.
- **New memberships** during an account window are allowed and are erased with the rest.

### Pairings

`connection_pairings` rows start with `install_name` and no `member_id` (`routes/pairings.ts`, start). Decline only sets `cancelled_at`, and nothing sweeps expired rows, so a device name can outlive everything. Phase 1 changes both:

- Decline records `member_id` of the member who declined, so step 1 finds it.
- The existing blob-cleanup interval also deletes pairing rows that expired more than an hour ago and were never consumed (pairings last 10 minutes). No pairing started before an erasure survives its 72-hour window.

### Owner deletion from `suspended` and `held`

Phase 1's account copy tells an owner to delete their community first, but today the owner's deletion request (`POST /owner/deletion`, `routes/administration.ts`) is allowed only from `active` and `archived`, and suspension blocks every member request. So an owner of a suspended community could never delete their account. The owner's deletion request is now also allowed from `suspended` and `held`, through a new, narrow carve-out in the tenant context for that one route (owner export is allowed only in `active` and `archived` and is not changed), with the same reauthentication and name confirmation. Entering `deletion_pending` nulls `suspended_from_state` (and `held_from_state`), because the lifecycle checks tie each to its own state (`communities_suspension_state`, `schema.ts`). So the migration adds `communities.deletion_from_state` (shared with the host-operator hold migration; whichever lands first adds it) with values `active`, `archived`, `suspended`, `held`, and `communities.deletion_from_prior_state`, set exactly when `deletion_from_state` is `suspended` or `held` and holding the state that suspension or hold started from, both enforced by a check and both NULL outside `deletion_pending`. A cancel restores `lifecycle = deletion_from_state` and, for `suspended` or `held`, restores `suspended_from_state` or `held_from_state` from `deletion_from_prior_state`, in one update that satisfies every lifecycle check. Suspension or hold does not stop the deletion worker once the seven days pass.

### Export changes

- The owner export's member query becomes a `LEFT JOIN "user"`, so erased husks stay in the archive with `email: null`. The host-operator spec's phase 4 makes the same change and makes `email` nullable in `CommunityExportManifestV1Schema`; whichever lands first makes both, and the other drops its copy.
- `export_archives` gains `content_version`, read from `community_content_versions` in the snapshot transaction. Both an export and an erasure take the community row only `FOR SHARE`, so that row cannot order them: the version row does. Every erasure transaction that changes content or deletes exports runs `UPDATE community_content_versions SET version = version + 1` in the **same** transaction as the change, and export commit reads `SELECT version FROM community_content_versions WHERE community_id=$1 FOR SHARE` in its commit transaction before inserting the archive row, so one of the two waits for the other. Export commit refuses with `409 STATE_CONFLICT` ("The community changed while this export was being made. Try again.") and discards the blob when the version has moved.

### Routes

Account routes sit on `hostApi` beside `/memberships` and need a signed-in browser session.

| Route                                                 | Body                                                                                               | Result                                                                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/account/former-memberships`              |                                                                                                    | memberships of this account that are no longer active: `communityId`, community name, `leftAt`, and any open erasure. `GET /memberships` stays active-only                             |
| `GET /api/v1/account/erasures`                        |                                                                                                    | this account's open requests and those cancelled in the last 30 days, with community names. A completed membership erasure no longer appears: nothing links it to the account any more |
| `POST /api/v1/account/erasures`                       | `{ kind: 'membership', communityId, password? }` or `{ kind: 'account', confirmEmail, password? }` | `201 { erasure }`; a repeat while one is open returns the open one with `200`                                                                                                          |
| `POST /api/v1/account/erasures/:id/cancel`            |                                                                                                    | `200 { erasure }`; `409` after `executeAfter`                                                                                                                                          |
| `GET /api/v1/communities/:communityId/owner/erasures` |                                                                                                    | owner only: **completed** self-erasures in this community (husk id and completion time). A scheduled one is not shown, so the owner cannot pressure the person during the window       |

`kind: 'membership'` needs a `members` row for this account in that community, active or not. `confirmEmail` must equal the account's email exactly.

```ts
CommunityWireErasureSchema = z.strictObject({
  id,
  kind: z.enum(['membership', 'account']),
  state: z.enum(['scheduled', 'running', 'completed', 'cancelled']),
  communityId: id.nullable(),
  communityName: z.string().nullable(), // account routes only, the person's own memberships
  executeAfter: timestamp,
  createdAt: timestamp,
  completedAt: timestamp.nullable(),
  cancelledAt: timestamp.nullable(),
});
```

Task 1.2 adds `requestedBy`. The object is new and only the same-origin browser bundle parses it, so adding a field later is safe.

### Worker

`src/erasure-worker.ts`, started from `main.ts` beside the deletion worker, polls every 30 seconds. It claims one due request (`state IN ('scheduled','running') AND execute_after <= now() AND next_attempt_at <= now()`) with `FOR UPDATE SKIP LOCKED`, and in the claiming transaction sets `state='running'` and `next_attempt_at = now() + interval '5 minutes'` as a lease, copying `deletion-worker.ts`. It then runs the procedure and marks `completed`. A failure records an error class (`^[A-Z][A-Z0-9_]{0,63}$`, never a message), increments `attempts`, and backs off with the existing cleanup backoff. A worker that dies leaves the lease to expire and another replica resumes. Blob bytes are removed by the existing pending-deletion sweep, which retries; a store delete whose outcome was uncertain is retried an hour later before the `managed_blobs` row (with its checksum) goes.

On completion, `parent_request_id` is cleared. Completed and cancelled requests are deleted 30 days after they end.

### Backup re-application

A host restoring a backup taken before some erasures must run them again.

- **The list.** Each completed erasure logs one line (above). Logs on many platforms are short-lived, so the server also appends the same line to an erasure journal file when `COMMUNITY_ERASURE_JOURNAL` names a path. The self-hosting docs require a host to keep either the log lines or the journal, **outside the database backup set, for at least as long as it keeps backups.**
- **The command.** `pnpm --filter @dorkos/community erasure:reapply < journal` reads `member <communityId> <memberId>` and `account <userId>` lines, runs `eraseMembership` or `eraseAccount` for each with the web service stopped (like `recover-password`), and prints only counts.
- **Cached copies.** A restore rewinds the `entry_redactions` sequence, so a DorkOS installation's saved feed cursor (task 2.1) would skip re-applied rows. `communities.redaction_epoch` (new, a random 64-bit value set at creation) is signed into every feed cursor, and `erasure:reapply` sets it to a **new random value** for every community it touches (not an increment: a second restore would rewind an incremented value to one that old cursors already carry), so old cursors answer `410` and installations read the feed again from the start.

### Data model changes (migration: next free number at build time)

- `erasure_requests(id uuid PK, kind CHECK IN ('membership','account'), user_id text NULL REFERENCES "user"(id) ON DELETE SET NULL, community_id uuid NULL REFERENCES communities(id), member_id uuid NULL, parent_request_id uuid NULL REFERENCES erasure_requests(id), state CHECK IN ('scheduled','running','completed','cancelled'), execute_after, created_at, started_at, completed_at, cancelled_at, attempts int NOT NULL DEFAULT 0, next_attempt_at, last_error_class CHECK (~ '^[A-Z][A-Z0-9_]{0,63}$'))`. Checks: `kind='account'` ⇒ `community_id` and `member_id` NULL (its `user_id` is set until the account row is deleted); `kind='membership'` ⇒ `community_id` and `member_id` set and `user_id` NULL, so no row links an account to a community; `execute_after >= created_at`; timestamps match the state. Composite tenant foreign key `(community_id, member_id)` to `members(community_id, id)`. Partial unique indexes: one open (`scheduled`/`running`) membership request per `(community_id, member_id)`, one open account request per `user_id`. Due index on `(next_attempt_at, execute_after) WHERE state IN ('scheduled','running')`.
- `entry_redactions(id bigint GENERATED ALWAYS AS IDENTITY PK, community_id, channel_id, entry_id, created_at)` with tenant foreign keys to `channels` and `entries`, index `(channel_id, id)`.
- `community_content_versions(community_id uuid PK REFERENCES communities(id), version bigint NOT NULL DEFAULT 1)`, a row per community (backfilled; created with every new community).
- `communities.redaction_epoch bigint NOT NULL` (random, backfilled per community).
- `entries.erased_at timestamptz NULL`.
- `members.erased_at timestamptz NULL`; `members.user_id` drops `NOT NULL`; the user-presence check becomes `user_id IS NOT NULL OR erased_at IS NOT NULL OR (origin='imported' AND NOT active)`. If the import migration (host-operator phase 4) has not landed, the check is `user_id IS NOT NULL OR erased_at IS NOT NULL`, and the import migration widens it. Whichever lands second owns the combined check.
- `export_archives.content_version bigint NULL` (NULL on rows written by old code is treated as version 1).
- The tenant deletion worker deletes the tenant's `entry_redactions`, `erasure_requests`, and `community_content_versions` rows before its members.
- `src/schema.ts` mirrors all of it.

### Code structure

- `apps/community/src/erasure.ts`: `eraseMembership`, `eraseAccount`, `rewriteHandleTokens` (pure, unit-tested), tombstone constants, journal append.
- `apps/community/src/mentions.ts`: export the masking and address pattern for `rewriteHandleTokens` (no second copy).
- `apps/community/src/erasure-worker.ts`: polling, lease, backoff, 30-day pruning.
- `apps/community/src/routes/erasures.ts`: account routes (`hostApi`) and the owner's completed-erasure list (`communityApi`), registered from `app.ts`.
- `apps/community/src/routes/members.ts` (transfer guard), `routes/invites.ts` (re-admission guard), `routes/host.ts` (owner-claim guard), `routes/pairings.ts` (decline records the member), `routes/attachments.ts` (commit refuses an inactive principal, if it does not already), `auth.ts` (session-creation refusal while running), `storage/pending-deletions.ts` or the cleanup interval (expired pairings).
- `apps/community/src/routes/exports.ts`: `LEFT JOIN`, content version.
- `apps/community/src/config.ts`: `COMMUNITY_ERASURE_JOURNAL` (optional path).
- `apps/community/src/erasure-reapply.ts` + `package.json` script.
- `packages/shared/src/community-wire.ts`: the schemas above and `REAUTH_REQUIRED`.
- Browser: `Manage.tsx`, `CommunityChooser.tsx`.

### Task 1.2 — the owner erases a former member (after import)

Depends on the import task (host-operator API task 4.2), because imported historical members are the main people only an owner can erase. Its design:

- **Who.** The current owner, with reauthentication, for a member who is not active (removed, left, or imported). `POST /api/v1/communities/:communityId/owner/erasures { memberId, password? }`, `POST …/owner/erasures/:id/cancel` (owner-made only), `GET …/owner/former-members?cursor=` (inactive members with name, handle, `removedAt`, origin, open erasure; 50 per page). The owner list of erasures gains owner-made requests in every state. `erasure_requests` gains `requested_by ('self','owner')`, `requested_by_member_id`, and `subject_user_id` (the target's account, if any, kept only until completion); the open-request unique index includes `requested_by`; the wire object gains `requestedBy`. Completion clears `requested_by_member_id`.
- **Re-admission (finding 1a).** The target is checked at request time **and** by the worker at execution (still not active, else the request is cancelled with error class `MEMBER_READMITTED`). Re-admitting the target by invitation during the window cancels the owner-made request in the same transaction and writes `member.erase.cancel`.
- **The target's view (finding 8).** A target who still has an account sees the owner-made request in `GET /account/erasures` with its date, and may request a personal export of their own messages during the window, a narrow exception to the active-member rule in `routes/exports.ts`. They cannot cancel it; the UI tells them to contact the owner.
- **Owners of a community being deleted (finding 15).** An account erasure may proceed while the person owns a community in `deletion_pending`: the owner membership is husked (name, handle, `user_id`) with `role` and `active` kept for the owner-lifecycle trigger, steps 2 to 5 are skipped because tenant deletion removes everything, the owner cannot cancel that deletion while the account request is open, and the worker re-checks at execution that the community is still `deletion_pending` (else it retries later with error class `OWNER_ACTIVE`).
- **UI.** `CommunityAdministration.tsx`, "Former members": list → **Erase** → "Erase {name}'s messages? In 72 hours, we'll remove their name, messages, files, and agents' messages from this community. Do this when they ask you to. You can cancel until then." + password.
- **Tests.** The AC-6 owner and admin cases below, owner-made requests in AC-8, the re-admission and deletion-pending cases in AC-7 and AC-9, and imported members in AC-10.

### Task 2.1 — DorkOS installations drop their cached copies

- **The feed (community server).** `GET /api/v1/communities/:communityId/channels/:id/redactions?cursor=&limit=` (and the single-community alias), same authorization as `GET /channels/:id/entries`. Oldest first, at most 100 per page: `CommunityWireRedactionPageQuerySchema = { cursor?, limit? 1–100 }`, `CommunityWireRedactionPageSchema = { redactions: [{ entry: CommunityWireEntry }] (max 100), nextCursor | null }`. Each item is the entry's **current** projection. The cursor is signed like page cursors, carrying `kind: 'redaction'`, the channel, the `entry_redactions.id`, and `communities.redaction_epoch`; a foreign cursor or an older epoch answers `410`. The route is new, so older installations never call it, and an installation calling an older server gets `404`.
- The live stream is unchanged: no new event type (it would break strict parsers) and no epoch bump (it would close everyone's live streams, and cursors stay valid because seq does not change). An open browser tab shows the old text until it reloads.
- **The mirror (DorkOS app).** `community_room_mirrors` gains `redaction_cursor`. After every `replay_complete` and every 15 minutes while subscribed, the remote subscription runtime pages the feed per mirrored room from the stored cursor (a `410` resets it to the start). For each item whose entry is in `community_mirror_entries`, in one SQLite transaction with `PRAGMA secure_delete=ON`: update `room_entries.body` and `mentions`, `community_mirror_entries.entry_json`, `author_display_name`, `author_kind`, and for a tombstone the external author's display name in `authors`; store the cursor. Never dispatch a local agent for it.
- **Search.** Message search indexes above a per-room watermark and never sees an in-place update (`row-frontier.ts`), so after a page that changed rows, drop that room's frontier so it re-indexes from the start, and run the FTS5 `optimize` command afterwards so old terms leave the index's shadow tables. Add a per-container invalidation to the frontier store if none fits.
- A `404` with no error code marks the connection as not supporting the feed, logged once. The mark lasts an hour for the 15-minute interval; every reconnect's replay asks again, so an upgraded server is found at once (amended 2026-09-25).
- **Revoked mirrors.** A member who has left or been removed, or whose agents are no longer in a channel, can no longer read its feed, so the installation deletes that mirror's content when the mirror is revoked: its room entries, cached entries, and their search rows (amended 2026-09-25; before, the copy was kept and a later erasure could never reach it).
- **Limits, stated in the UI and docs.** Anything a member's local agents saved (session transcripts, memory) is theirs and is not touched, and message search still finds it there.

## User Experience

Copy follows the `writing-for-humans` skill. Every screen that starts an erasure says what it cannot reach, in the same words:

> We can't reach copies on other people's computers, including files they downloaded and anything their agents saved, or the host's backups for as long as it keeps them.

**Erase me from one community** (`Manage.tsx`, beside "Leave community" for non-owners; for communities the person already left, from the host root's "Communities you left" list, fed by `GET /account/former-memberships`):

> **Erase your messages here**
> In 72 hours, we'll remove your name, messages, files, and your agents' messages from {community}. Your messages stay in their place in conversations, marked "This message was erased." You can cancel until then.
> {cannot-reach sentence}
> [Enter {community}] [Confirm password] **Erase my messages**

Owners see "Transfer ownership or delete the community before you erase your messages here." While scheduled, that person sees a banner in the community: "Your messages here will be erased on {date}. **Cancel**".

**Delete your account** (`CommunityChooser.tsx`, host root):

> **Delete your account**
> In 72 hours, we'll delete your account on this host and erase your name, messages, files, and agents from every community here, including ones you left. You can cancel until then by signing in. When it starts, you'll be signed out everywhere.
> {cannot-reach sentence}
> [Enter your email] [Confirm password] **Delete my account**

If the person owns a community, the button is replaced by: "You own {names}. To delete your account, first transfer ownership to another member or delete {the community / those communities}, then wait until the deletion finishes. You can ask to delete a community even while the host has put it on hold or suspended it." The host root lists scheduled erasures with their dates and a **Cancel** button each.

Errors are plain sentences from the server. Other members see no sign of an erasure until it runs; the owner sees completed ones only.

## Testing Strategy

Integration tests run against real PostgreSQL and the filesystem BlobStore, using `tenancy-test-harness.ts`. Each test carries a purpose comment. ACs marked (1.2) or (2.1) belong to those tasks.

### Acceptance criteria that discriminate

**AC-1 — Residue scan (the core test).** Seed two communities on one host. In community A, person P (display name `Zephyrine Quill`, email `zq-canary@example.test`) joins and:

- pairs an installation named `zq-canary-laptop`; starts a second pairing named `zq-canary-declined` that P declines; and starts a third named `zq-canary-abandoned` that is never approved and expires;
- enrolls an agent `ZQ Canary Bot` with `local_agent_id` `zq-canary-local`;
- posts a top-level message with `canary-text-1`, a reply in someone else's thread, an agent post with `canary-text-2`, and a message with an attachment `zq-canary.txt` whose bytes contain `canary-bytes-1`; leaves one unbound upload; uses idempotency key `zq-canary-key`;
- as an admin, names a channel `zq-canary-channel` (a named leftover, AC-10).

Member Q posts `@<P's handle> thanks`, a message mentioning P's agent, and a code block containing `@<P's handle>` (a named leftover). Q makes a personal export and the owner makes an owner export, both within their hour. In community B, P is also a member with the same kinds of canaries.

The scan enumerates **every table and every column** of type `text`, `varchar`, `text[]`, `json`, and `jsonb` in the `public` schema from `information_schema.columns` (never a hand list), every object in the BlobStore, and the log output captured during the test. It matches case-insensitively, and on each of: the display name, each word of it, P's handle, the agent's handle, the email, every `canary-…` string, and the SHA-256 hex of each of P's entry payloads and of each canary file's bytes.

- **Control (before):** every canary is found in its expected place. If one is not, the test fails: a canary the scan cannot see proves nothing.
- **After P erases their membership in A**, with the worker and blob sweep run to completion (clock advanced past the sweep's one-hour retry): no canary in any row with `community_id = A`, in any blob that belonged to A, or in the log, except AC-10's named leftovers. Community B keeps every canary.
- **After P deletes their account:** no canary anywhere on the host, except the named leftovers. The `"user"`, `session`, `account`, and `verification` rows for P are gone.
- A table added later that stores a person's data fails this test until erasure covers it, because the scan enumerates the schema.

**AC-2 — Thread shape.** After erasure, every entry of P and P's agent in A has the same `id`, `seq`, `parent_entry_id`, `thread_root_entry_id`, and `created_at` as before; history returns them with text `This message was erased.`, author `Erased member` / `Erased agent`, `mentions: []`, `attachments: []`; each response parses with the unchanged `CommunityWireEntrySchema`. Q's reply still lists P's erased message as parent; a thread query on P's erased root still returns Q's replies. A page cursor and a live-stream resume cursor taken before erasure still work after it (no `410`).

**AC-3 — Mentions.** Q's `@<handle> thanks` reads `@[erased] thanks`; Q's mention of P's agent reads `@[erased]`; the code block is unchanged; no `entry_mentions` row targets P or P's agent. Q's retry of their original post with its original key and payload returns `200` (payload hash unchanged). A new member can take P's old handle, and `@<old handle>` then resolves to the new member only. Unit cases for `rewriteHandleTokens`: `@zq,` and `@zq.` (punctuation kept), `@zq_` and `@zq-` (trailing strip), `@ZQ` (case), `@zq2` and `@zqx` (different handles, untouched), `x@zq` and `bob@zq.com` (untouched), `@types/node` inside a fence and inline code when a handle is `types` (untouched), a quoted line (untouched).

**AC-4 — Files and exports.** P's blobs in A are gone from the BlobStore after the sweep, `GET /attachments/:id` answers `404`, and no `managed_blobs` row keeps their checksums. Both pre-erasure exports answer `404` at `GET /exports/:id` and their blobs are gone. An export snapshotted before the erasure's first content change and committed after it (test hook) is refused with `409` and leaves no blob; so is one snapshotted before the seal step and committed after it (a second hook inside the seal, whose bump must share the seal's transaction). An upload P started before step 2 and committed after it (test hook) is refused, or, if it commits, is removed by the seal. An owner export made after erasure has P's husk with `email: null` and no canary.

**AC-5 — Window and cancel.** A request is `scheduled` with `executeAfter` exactly 72 hours after `createdAt`. A digest of every community-A row outside `erasure_requests` is equal just after the request and just before execution when nothing else happens in between; separately, P can still post during the window. Cancel returns `cancelled` with that digest unchanged; after `executeAfter`, cancel answers `409`; the worker never runs a cancelled request.

**AC-6 — Authority.** Every erasure route answers `403` for a connection-grant bearer, an agent bearer, and a host API key. A host operator who is **not** a member of A, using both a host API key and their own session, cannot create, cancel, or list an erasure for P (their session reaches only their own account's requests, and has no membership in A to name). P cannot erase a membership they own (`403`). Account deletion is `403` for an account with any `host_operators` row (revoked or not) and `409` for the owner of a community in any state. (1.2) Admins and members cannot erase another member (`403`); the owner cannot erase an active member (`409`); a person cannot cancel an owner-made request and an owner cannot cancel a self-made one.

**AC-7 — Guards.** During P's window, transfer of ownership to P is `409`, and an owner claim by P's account (account erasure) is `409`. While P's membership erasure in A runs, P's session redeeming an invite to A is refused (`409`); while P's account erasure runs, every invite redemption, owner claim, and sign-in by P is refused, including sign-in by an account that uses only GitHub (a stubbed provider), and P's existing sessions no longer work. A membership P gains during an account window is erased at execution. (1.2) Re-admitting an owner-erasure target during the window cancels the request; a target re-admitted by other means is not erased (worker re-check).

**AC-8 — Crash and repeat.** Kill the worker after each of steps 1 to 6 and after each account step (test hook), let the lease expire, and the final state equals an uninterrupted run (same digest). P posting, uploading, and enrolling an agent between steps 1 and 6 (test hook bypassing the guards, to simulate a missed check) leaves nothing after the seal. Running `eraseMembership` twice, or `erasure:reapply` after completion, changes nothing.

**AC-9 — Every lifecycle.** An erasure scheduled in A completes when A is `archived`, `held` (once the hold exists), `suspended`, and `deletion_pending` at execution time. The owner can request deletion of a `suspended` community (suspended from `archived`) and of a `held` one (once the hold exists); cancelling each returns it to `suspended` with `suspended_from_state = 'archived'`, or to `held` with its `held_from_state`, and every lifecycle check still passes. (1.2) An account erasure with a `deletion_pending` community P owns husks P's owner row, and the tenant deletion later removes the rest.

**AC-10 — Named leftovers.** The only matches the scan may find after erasure, each asserted explicitly so nobody later claims otherwise: a free-text display name typed by another member (`thanks Zephyrine`), P's handle inside another member's code block or quote, an email-shaped string such as `bob@<P's handle>` in another member's message (not rewritten, because of the left-boundary rule, even though today's resolver has no such rule and may have resolved it), the channel name P set as an admin, and audit rows holding the husk's id. (1.2) The owner can erase an imported historical member and a member who left before this feature shipped.

**AC-11 — Locks.** While a batch of P's erasure is open (test hook), Q can post in A, reply to an entry inside that batch, and read history, each within a normal timeout and without a deadlock error.

**AC-12 — Backup re-application.** Configure `COMMUNITY_ERASURE_JOURNAL`. Snapshot the database and BlobStore, erase P, restore the snapshot, run `erasure:reapply` with the journal: the AC-1 scan passes again, P's restored account is deleted, and `communities.redaction_epoch` differs from its value before the snapshot and after the restore; a second restore of the same snapshot and a second reapply give yet another value. (2.1) A feed cursor saved before the restore answers `410`, and a fresh read returns every redaction.

**AC-13 — Redaction feed (2.1).** Before erasure the feed for a channel is empty; after it, one item per changed entry with its current projection, each strict-schema valid; `404` for a channel the caller cannot read; `410` for another channel's cursor.

**AC-14 — DorkOS installation (2.1).** A DorkOS test server paired to community A mirrors a channel where P posted `canary-text-1` and Q mentioned P, indexes it, and dispatches a local agent on P's message (so the agent's transcript contains the canary). Control: the raw bytes of the SQLite database file and its WAL after a checkpoint, and a message search restricted to rooms, all find the canary. After P's erasure and one feed sync: the raw database file and WAL do not contain any canary (`secure_delete` and FTS `optimize` make this true), room search finds nothing, mirrored entries show the tombstone and Q's `@[erased]`, the external author reads `Erased member`, and no local agent was dispatched by the sync. The agent's transcript still contains the canary, and a search over sessions still finds it there: a named limit, asserted so the copy stays honest. Against a server without the route (`404`), sync logs once and changes nothing.

### Other tests

- Unit: `rewriteHandleTokens` (AC-3 cases); the tombstone payload hash; the reauthentication rule (password account; OAuth-only account with fresh and stale sessions).
- Browser: both flows show the cannot-reach sentence; owners see the transfer message; the account panel lists owned communities; cancel updates the banner; the "Communities you left" list offers erasure.
- Migration: old code against the new schema, and the user-presence check under both orders of this migration and the import migration.
- Pairings: a declined pairing records the decliner; an expired, never-consumed pairing is deleted by the sweep.

### Mocking strategy

None for PostgreSQL or the BlobStore (real ones, as the tenancy suites do). The clock is injected into the worker and the sweep so the window and retries are tested without waiting. Task 2.1 uses a real community server from the community harness and a real DorkOS SQLite database.

## Performance Considerations

- Candidates are found without locks; each batch of at most 500 rows is locked by id. Every erasure transaction holds the community row only `FOR SHARE`, which posts and reads also take, so a community keeps working while one of its members is erased (AC-11).
- The mention step pre-filters with `position()` over one community's entries once per erasure, in the background; the seal re-scans only above the per-channel watermark. `entry_mentions(community_id, mentioned_member_id)` is already indexed.
- The content version is its own row, bumped once per batch, contended only by export commits.

## Security Considerations

- Erasure is irreversible after the window, so every request reauthenticates, and the account form also asks for the email typed exactly. The window defends against a mistake or a stolen session; a stolen password defeats it, as it defeats every account control.
- An account erasure signs the person out everywhere and refuses sign-in, invitation, and owner claim while it runs, so nothing new can be written under the account mid-erasure.
- Host authority has no erasure route, and no host route reports erasures. Host usage figures change as bytes are removed; that is all the host can see.
- An account that has ever been a host operator cannot be deleted online: `host_audit_events.actor_user_id` is a required reference to the account, and host audit rows must keep naming who acted, so even a revoked operator's account stays. Such a person can still erase each membership. Closing their account is an offline host task (follow-up command).
- The owner sees completed self-erasures only, never a scheduled one.
- Log lines and the journal carry ids only. Error classes are codes, never messages.
- The random husk handle is unguessable, so it cannot be used to find the person again.
- **Physical residue is part of the limit, and the docs say so.** Deleted rows remain in PostgreSQL dead tuples until vacuum, and in WAL and point-in-time-recovery archives for as long as the host keeps them. The S3 store deletes without a version id (`storage/s3-blob-store.ts`), so on a versioned bucket old versions stay: the self-hosting docs require an unversioned bucket, or a lifecycle rule that expires noncurrent versions, and state that backup and recovery retention is how long erased data can still exist on the host.

## Documentation

- `docs/guides/communities.mdx`, "Export or leave": erasing your messages and deleting your account, the 72-hour window, and the cannot-reach sentence.
- The self-hosting docs: host operators cannot erase for a person; how to help someone who cannot sign in (offline password recovery); keeping the erasure log or journal outside the backup set for as long as backups; `erasure:reapply` after a restore; unversioned buckets or noncurrent-version expiry; backup and recovery retention as part of what erasure cannot reach.
- A changelog fragment in `changelog/unreleased/` for each task.
- `specs/community-host-operator-api/02-specification.md`: its Open Question 7 points here; its hold rules list erasure and the owner's deletion request as allowed while held; its import section notes the shared `LEFT JOIN` and user-presence check.

## Implementation Phases

- **Phase 1, task 1.1 — Self-erasure on the Community server (host launch blocker).** Migration; procedures, worker, account routes, guards, pairing cleanup, export changes, owner deletion from `suspended` and `held`, journal and reapply CLI, browser flows, docs. AC-1 to AC-12 except the parts marked (1.2) or (2.1).
- **Phase 1, task 1.2 — The owner erases a former member.** After the import task (host-operator API task 4.2). Owner routes, re-admission handling, the target's view and export, the `deletion_pending` owner case, owner UI. The (1.2) parts of AC-6 to AC-10.
- **Phase 2, task 2.1 — The redaction feed and DorkOS installations (hosted launch blocker, DOR-2266).** It reaches copies on members' own machines. It became a launch blocker on 2026-09-23 (coordinator decision): without it, the text of a message a host took down for being illegal (`specs/community-host-takedown/`) stays in every member's DorkOS mirror and message search. Build order: `specs/community-single-item-delete/` task 1.1 lands first, because it moves the removal helpers into `content-removal.ts`, fixes their order (the content version is bumped, taking its row lock, **before** any `entry_redactions` row is inserted, so redaction ids become visible in the order they commit), and refactors erasure onto them; the feed's cursor relies on that order. Phase 1 writes `entry_redactions` from its first erasure, so this catches up on every earlier erasure. AC-12 (2.1 part), AC-13, AC-14.

### Backout

- Task 1.1: before any erasure has run, revert the code; the migration stays and old code ignores the new tables and columns. After one has run, the supported path is forward-fix: old code's owner export inner-joins `"user"` and would silently drop every husk, leaving entries whose author is missing from the archive. If a revert is unavoidable, cancel every open request first and accept that owner exports are incomplete until the fix ships.
- Task 1.2 and 2.1: revert the code; their columns stay and are ignored.

## Open Questions

None open. Resolved while specifying:

- ~~What does a thread show in place of an erased message?~~ (RESOLVED) **Answer:** the row stays with its position and thread links; text `This message was erased.`, author `Erased member` or `Erased agent`, no mentions, no attachments. **Rationale:** keeps threads, cursors, and unread counts working and fits the strict wire unchanged.
- ~~Per community or the whole account?~~ (RESOLVED) **Answer:** both, from one per-membership procedure. **Rationale:** accounts are host-wide and authority is per membership (ADR `260920-192429`).
- ~~Are the person's agents' posts erased?~~ (RESOLVED) **Answer:** yes. **Rationale:** the person owns the agent, and its posts carry their data.
- ~~Mentions in other people's messages?~~ (RESOLVED) **Answer:** mention rows deleted; handle tokens the resolver would see rewritten to `@[erased]`; code, quotes, email-shaped strings, and free text untouched. **Rationale:** the handle is released and must not come to name someone else, but rewriting inside code would damage it.
- ~~Attachments?~~ (RESOLVED) **Answer:** hard delete through the blob inventory.
- ~~Exports?~~ (RESOLVED) **Answer:** every live export in the community is deleted; an export snapshotted before an erasure cannot commit; downloaded files cannot be recalled, and the UI says so.
- ~~Audit trail?~~ (RESOLVED) **Answer:** kept, ids and action names only.
- ~~Immediate or a grace period?~~ (RESOLVED) **Answer:** 72 hours, cancellable, nothing changes until it runs.
- ~~Host hold, import, owner export?~~ (RESOLVED) **Answer:** erasure runs in every lifecycle state; the owner export keeps husks with `email: null`; imported members are erased by the owner (task 1.2).
- ~~Can the owner erase a removed member on request?~~ (RESOLVED) **Answer:** yes, in task 1.2, after import. **Rationale (operator):** phase 1 is what a host needs at launch; the owner path matters most for imported members.
- ~~Can a suspended or held community's owner delete it?~~ (RESOLVED) **Answer (operator):** yes, the owner may request deletion from `suspended` and `held`; account erasure still requires owning nothing, and the copy explains how.
- ~~When does the owner learn of a self-erasure?~~ (RESOLVED) **Answer (operator):** only after it completes.
- ~~How do OAuth-only accounts reauthenticate?~~ (RESOLVED) **Answer:** a session less than 5 minutes old. **Rationale:** they must be able to erase themselves at launch; the general OIDC reauthentication follow-up (host-operator spec Open Question 5) can replace it.
- ~~How does a host redo erasures after restoring a backup?~~ (RESOLVED) **Answer (operator):** both a retention requirement for the log or journal outside the backup set, and a redaction epoch in feed cursors that `erasure:reapply` bumps.
- ~~Should the live stream announce erasures?~~ (RESOLVED) **Answer:** no; a separate pull-only feed (task 2.1). **Rationale:** a new event type breaks strict parsers in every older installation, and an epoch bump closes everyone's streams for no gain.

## Changelog

- **2026-09-23** — Procedure steps 2 to 5 amended: every transaction that inserts `entry_redactions` rows bumps the content version first; step 2 writes a redaction row per bound entry whose file it deletes; step 3 deletes only `ready` exports and queues their segment blobs before deleting the rows. Built in `specs/community-single-item-delete/` task 1.1.
- **2026-09-23** — Task 2.1 (the redaction feed and DorkOS mirror replacement, DOR-2266) is now a hosted-launch blocker, because host takedowns rely on it. It is built after `specs/community-single-item-delete/` task 1.1, which refactors erasure's removal helpers into `content-removal.ts` and bumps the content version before inserting redaction rows.

## Related ADRs

- `260923-134614` — Erasure tombstones a member's history in place and deletes everything else (accepted, from this spec)
- `260923-134616` — Member erasure belongs to the person and the community owner, after a 72-hour cancellable window (accepted, from this spec)
- `260920-201101` — Separate community retention from permanent tenant deletion (the same window-and-worker shape, one level down; host authority stays out)
- `260920-192429` — Scope host accounts through immutable community memberships (account erasure spans every membership)
- `260923-121712` — Host hold and host-started deletion (draft, host-operator spec; erasure and the owner's deletion request are allowed while held)
- `260923-121153` — Import restores an owner export with historical members (draft, host-operator spec; shares the nullable `user_id` and the `LEFT JOIN`; task 1.2 depends on it)

## References

- DOR-2247 — this specification
- DOR-2243 and `specs/community-host-operator-api/02-specification.md` (Open Question 7, migrations 0012 to 0015, task 4.2)
- `specs/community-tenancy-contract/02-specification.md`, `specs/community-administration-contract/02-specification.md`
- `apps/community/src/routes/members.ts`, `routes/invites.ts`, `routes/pairings.ts`, `routes/entries.ts`, `routes/exports.ts`, `routes/events.ts`, `routes/host.ts`, `routes/administration.ts`, `routes/attachments.ts`, `mentions.ts`, `handles.ts`, `auth.ts`, `data.ts`, `schema.ts`, `deletion-worker.ts`, `recover-password.ts`, `storage/managed-blobs.ts`, `storage/pending-deletions.ts`, `storage/s3-blob-store.ts`
- `packages/shared/src/community-wire.ts`, `packages/shared/src/handle.ts`
- `apps/server/src/services/communities/remote/mirror-store.ts`, `apps/server/src/services/search/registry.ts`, `row-frontier.ts`
- Better Auth 1.7 verification rows (`reset-password:<token>` identifiers, user id as value)
- GDPR Art. 17 (right to erasure; "without undue delay"); California Civil Code §1798.105 (CCPA right to delete)
