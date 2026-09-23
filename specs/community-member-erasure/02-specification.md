---
slug: community-member-erasure
number: 260923-134613
created: 2026-09-23
status: specified
linear-issue: DOR-2247
project: Cloud-Hosted Communities
---

# Community member erasure

**Status:** Draft
**Author:** Claude (for DOR-2247)
**Date:** 2026-09-23

## Overview

A person on a Community host can erase themselves from one community, or delete their account and be erased from every community on the host. A community owner can erase a former member on that person's request. After a 72-hour window in which the request can be cancelled, the server removes the person's name, handle, account link, messages, files, agents, and connections, and rewrites mentions of them in other people's messages. Their messages stay in place in threads as `This message was erased.` so conversations keep their shape. Every live export in the community is deleted. DorkOS installations that are online replace their cached copies through a new, content-free redaction feed.

Erasure belongs to the person and to the community owner. Host authority (a host operator's session or a host API key) cannot request, cancel, speed up, or observe one, which keeps the rule from the host-operator API spec (Open Question 7) and ADR `260920-201101`: host authority never reads or writes community content.

## Background / Problem Statement

- Leave and removal (`routes/members.ts`, `remove()`) end access and revoke credentials, but keep `members.display_name`, `members.handle`, `members.user_id`, every entry with its `author_display_name`, every attachment, and every mention. The leave screen says so: "Your past messages stay attributed to you."
- Entries are immutable. There is no edit or delete route, so there is also no edit history to erase.
- A host account cannot be closed. Better Auth's `user.deleteUser` is not enabled in `auth.ts`, and even if it were, five columns reference `"user"(id)` without a cascade (`members.user_id`, `invite_uses.user_id`, `host_operators.user_id`, `host_audit_events.actor_user_id`, `bootstrap_grants.revoked_by`), so the delete would fail. (The host-operator API spec says accounts "can already be closed through Better Auth". That is not true today; this spec closes the gap.)
- Owner exports copy every member's email and every message into a zip that lives for an hour, and each member's DorkOS installation keeps a persisted mirror of the rooms it reads (`apps/server/.../remote/mirror-store.ts`), indexed by DorkOS message search.
- A host that serves people in the EU or California will receive erasure requests (GDPR Art. 17, CCPA deletion). Without this, hosted communities cannot launch.

## Goals

- A person can erase themselves from one community, or delete their account and be erased everywhere on the host, without anyone's help.
- A community owner can erase a member who is no longer active: removed, left, or an imported historical member.
- After erasure, no row, column, blob, export, or log line on the Community server holds the person's name, handle, email, account link, message text, file names, or file bytes, except where this spec names a limit.
- Other people's history stays readable: threads, replies, sequence numbers, read positions, and cursors keep working.
- One 72-hour cancellable window for every erasure, with nothing changed until it runs.
- No change to any existing wire object or SSE event, so every DorkOS installation keeps working.
- DorkOS installations that are online remove their cached copies, including from message search.
- The UI tells the truth about what erasure cannot reach.

## Non-Goals

- Any erasure started, cancelled, sped up, or read by host authority. A host that gets an emailed request uses the existing offline password recovery (`src/recover-password.ts`) so the person can sign in and erase themselves.
- Admins erasing anyone other than themselves.
- Deleting or editing single messages, for moderation or otherwise.
- Finding a person's name, words, or likeness in free text or files posted by other people or their agents. Only `@handle` mentions are rewritten.
- Recalling downloaded exports, reaching host backups directly, or reaching DorkOS installations that are offline, old, or modified.
- Legal holds. The server has none.
- A wire flag that lets clients style tombstones differently. It would change `CommunityWireEntrySchema`, which is strict. Follow-up with the next wire version.
- Closing a host operator's account online. Host operators are made offline at first install and close their accounts the same way.
- Time or effort estimates.

## Technical Dependencies

| Dependency                         | Version in repo              | Used for                                                                                                                                                   |
| ---------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hono`                             | 4.13.8                       | routes                                                                                                                                                     |
| `better-auth`                      | 1.7.5                        | `verifyPassword` reauthentication, session age for fresh-sign-in reauthentication; `deleteUser` stays disabled, the server deletes the account rows itself |
| `pg` + hand-written SQL migrations | `apps/community/migrations/` | one new migration, **the next free number at build time** (the host-operator API spec takes 0012 to 0015), added to the list in `src/migrate.ts`           |
| `drizzle-orm`                      | 0.45.2                       | `src/schema.ts` mirrors the migration; `@dorkos/db` migration for the DorkOS mirror (phase 2)                                                              |
| `zod`                              | ^4.1.13                      | new strict schemas in `@dorkos/shared/community-wire`                                                                                                      |
| Node `crypto`                      | built in                     | random husk handles, SHA-256 of tombstone payloads                                                                                                         |

No new runtime dependency.

## Detailed Design

### Shared rules

- **Who.** The person (a signed-in browser session for the account) or the current owner of the community. Every erasure route refuses a bearer credential of any kind (connection grant, agent credential, host API key) and a host operator's session acting as host authority (`403 FORBIDDEN`). A host operator who is also a member erases themselves like anyone else.
- **Reauthentication.** Password when the account has a `credential` account row (`auth.api.verifyPassword`); otherwise the request's session must have been created less than 5 minutes ago, or the route answers `403 REAUTH_REQUIRED` with a message to sign in again. The owner route always reauthenticates the owner the same way.
- **Window.** Every request is `scheduled` with `execute_after = created_at + 72 hours` (a constant, `ERASURE_WINDOW_HOURS`, not configuration). Nothing about the person changes until it runs. The requester cancels; for an owner request, the current owner cancels. After `execute_after`, cancel answers `409 STATE_CONFLICT`.
- **Every lifecycle.** Requests are accepted and erasures run in `active`, `archived`, `held`, `suspended`, and `deletion_pending`. In `held` and `archived` erasure is removal, not growth; the host-operator spec's hold rules must list it beside owner export as allowed.
- **Idempotent by member id.** The procedure below can be re-run on any member id at any point and converges to the same final state. That is what makes worker restarts, backup re-application, and overlapping requests (the person and the owner both asking) safe.
- **Tenant first.** Every step names `community_id` in its predicate and its locks, as every other tenant query does. Erasing one person never touches another community's rows.
- **Error codes.** One new code, `REAUTH_REQUIRED`, added to `CommunityWireErrorCodeSchema` (only the same-origin browser bundle and the community app parse it). Everything else reuses `FORBIDDEN`, `NOT_FOUND`, `STATE_CONFLICT`.

### What a thread shows

An erased entry keeps `id`, `channel_id`, `seq`, `parent_entry_id`, `thread_root_entry_id`, and `created_at`, so replies, thread roots, cursors, and unread counts are unchanged. In the database:

| Column                                 | After erasure                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `text`                                 | `This message was erased.`                                                                                                |
| `author_display_name`                  | `Erased member` (human) or `Erased agent` (agent)                                                                         |
| `author_member_id` / `author_agent_id` | unchanged: the husk's id                                                                                                  |
| `idempotency_key`                      | `erased:<entry id>`                                                                                                       |
| `payload_hash`                         | SHA-256 of the tombstone payload `{"text":"This message was erased.","mentions":[],"parentEntryId":…,"attachmentIds":[]}` |
| `erased_at` (new)                      | the time of erasure                                                                                                       |
| `entry_mentions` rows                  | deleted                                                                                                                   |
| `attachments` rows                     | deleted, blobs to cleanup                                                                                                 |

On the wire this is an ordinary `CommunityWireEntry` with that text and name, `mentions: []`, and `attachments: []`. Older DorkOS installations render it with no change. The same text is used whether the person or the owner asked, so a reader cannot tell which.

### Mentions in other people's messages

After erasure, the person's old handle is released (a newcomer may take it), so a leftover `@handle` could later seem to name someone else. For every other entry in the community (not the person's, not their agents'):

- delete every `entry_mentions` row whose target is the person's member id or one of their agent ids;
- in `text`, replace every case-insensitive `@<handle>` token for the person and each of their agents with `@[erased]`, where a token ends at the end of text or at a character that is not `[A-Za-z0-9_]` and is not a `.` or `-` followed by `[A-Za-z0-9]` (the same end rule `resolveCommunityMentions` uses). This applies inside code and quotes too: there it is not a mention, but it is still the handle.
- `payload_hash` and `idempotency_key` of other people's entries are **not** changed, so their own retries still replay.

`@[erased]` can never resolve as a mention: the address form in `src/mentions.ts` needs a letter or digit after `@`. Handles are never renamed today, so the current handle is the one used in every past message; a future handle-rename feature must keep past handles for this step.

Free-text names (`thanks Zephyrine`) are not touched (Non-Goals).

### The husk

The member row stays, because entries, audit rows, deletion requests, and invites point at it, but it no longer leads to anyone:

- `members`: `display_name = 'Erased member'`, `handle = 'erased-' || 12 random lowercase base32 characters`, `user_id = NULL`, `active = false`, `removed_at = COALESCE(removed_at, now())`, `erased_at = now()`. `role` is kept (see the owner case below). `created_at` is kept.
- `community_handles`: the row for this member is re-keyed to the new random handle, releasing the old one.
- Each agent the person owns: `display_name = 'Erased agent'`, a random `erased-…` handle (and its `community_handles` row), `local_agent_id = NULL`, `active = false`, `revoked_at = COALESCE(revoked_at, now())`.

### The procedure (one membership)

`eraseMembership(communityId, memberId)` in `src/erasure.ts`. Each numbered step is one or more short transactions that lock the `communities` row `FOR UPDATE` and then the member row, in that order (the same lock order as `live()` in `routes/members.ts`). Batches are 500 rows.

1. **End access.** If the member is active, run the existing `remove()` with action `member.erase.start` (it revokes agents, credentials, grants, pairings, channel memberships, read cursors, admission receipts). Delete the member's `connection_grants`, `connection_pairings`, and their agents' `agent_credentials` rows outright (they hold install names and token hashes). Delete `agent_channel_members`, `owner_quota_windows`, and, for this community, `invite_uses`, `pending_admissions`, and `admission_receipts` rows for the member's `user_id` (read before the husk step nulls it). Revoke the member's unexpired invites (`revoked_at = now()`), keeping the rows.
2. **Files.** Delete every `attachments` row uploaded by the member or their agents, bound or unbound, and queue each blob with the existing `queueCommittedBlobDeletion` (`storage/managed-blobs.ts`), or `discardManagedBlob` for an upload not yet committed, in the same transaction, so the pending-deletion sweep removes the bytes and any metadata the store keeps beside them (the stored display name).
3. **Exports.** Mark every `export_archives` row in the community with `deleted_at IS NULL` as deleted and move its blob to cleanup. Increment `communities.content_version` (new) in the same transaction.
4. **Tombstones.** Batches of entries `WHERE community_id=$1 AND erased_at IS NULL AND (author_member_id=$2 OR author_agent_id = ANY(agent ids))`: apply the tombstone table above, delete their mention rows, insert one `entry_redactions` row per entry, and increment `content_version`.
5. **Mentions.** Batches of other entries in the community that have a mention row for the person or their agents, or whose `text` matches one of their `@handle` tokens (`text ~* ('@' || regexp-escaped handle)` pre-filter, exact rule applied in code): delete the mention rows, rewrite the text, insert one `entry_redactions` row per changed entry, increment `content_version`.
6. **Seal.** One transaction: repeat steps 3 and 5 for anything written since they ran (another member can still type the literal handle until now), apply the husk, write the tenant audit row `member.erase.complete` (`actor_kind='system'`, `subject_id` = the husk id, no other fields), and mark this membership done. Emit one log line `{"event":"community.member_erased","communityId":…,"memberId":…}` with no other field.

The old handle stays in `members.handle` until step 6, so a restart at any point can still find the tokens to rewrite.

**The owner case.** A person cannot ask to erase a membership in which they are the active owner (`403 FORBIDDEN`, "Transfer ownership or delete the community first."), matching leave. The one exception is a community already in `deletion_pending` that the person owns: there the husk step runs (name, handle, `user_id`), but `role` and `active` stay as the owner-lifecycle trigger needs, and steps 2 to 5 are skipped because the tenant deletion removes everything within seven days. Nobody can cancel that deletion once the owner's account is gone (the host cannot cancel an owner-requested deletion), and, below, the owner cannot cancel it while their account erasure is scheduled.

### The procedure (whole account)

`eraseAccount(userId)`:

1. Refuse at request time if the account is in `host_operators` (`403 FORBIDDEN`) or is the active owner of any community not in `deletion_pending` (`409 STATE_CONFLICT`, naming the communities the person owns so they can act).
2. At execution, list every `members` row with this `user_id` (active or not, including ones joined during the window), create one child `membership` request per row (`parent_request_id` = the account request, `execute_after = now()`), and run `eraseMembership` for each.
3. When every child is done, in one transaction: delete `invite_uses` for the user (any community left over), `pending_admissions` and `admission_receipts` with `account_id` = the user, `verification` rows whose `identifier` is the user's email, and finally the `"user"` row (sessions and linked sign-in accounts cascade). `erasure_requests.user_id` becomes NULL by its `ON DELETE SET NULL`.

After this, the email address can be used to join again by invitation, as a new person with no link to the old history.

### Guards during the window

- **Ownership transfer** to a member with an open erasure (or whose account has one) is refused (`409 STATE_CONFLICT`, "That member is leaving this community.").
- **Owner-claim redemption** by an account with an open account erasure is refused (`409 STATE_CONFLICT`).
- **Cancelling a community deletion** by an owner whose account erasure is open is refused (`409 STATE_CONFLICT`, "Cancel your account deletion first.").
- **New memberships** during the window are allowed and are erased with the rest, since step 2 lists memberships at execution.

### Export changes

- The owner export's member query becomes a `LEFT JOIN "user"`, so erased husks (and imported historical members) stay in the archive with `email: null`. The host-operator spec's phase 4 makes the same change and makes `email` nullable in `CommunityExportManifestV1Schema`; whichever lands first makes both changes, and the other drops its copy.
- `export_archives` gains `content_version`, read in the snapshot transaction. Export commit, under the community lock, refuses with `409 STATE_CONFLICT` ("The community changed while this export was being made. Try again.") and discards the blob when `communities.content_version` has moved. This closes the race where an export snapshotted before an erasure is committed after it.

### Redaction feed

`GET /api/v1/communities/:communityId/channels/:id/redactions?cursor=&limit=` (and the single-community alias), same authorization as `GET /channels/:id/entries` for the same principal (browser session or connection grant with `read`). Oldest first, at most 100 per page:

```ts
CommunityWireRedactionPageQuerySchema = z.strictObject({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
CommunityWireRedactionPageSchema = z.strictObject({
  redactions: z.array(z.strictObject({ entry: CommunityWireEntrySchema })).max(100),
  nextCursor: cursor.nullable(),
});
```

Each item is the entry's **current** projection (a tombstone, or another person's entry with the rewritten text), read from `entry_redactions` joined to `entries`. The feed carries no reason and no link to the person. Cursors are signed like page cursors (`encodeCursor` with a new `kind: 'redaction'` field inside the signed value) over the `entry_redactions.id` sequence. A route that is new is additive: older installations never call it, and an installation calling an older server gets `404` and stops asking until restart.

The live stream is unchanged: no new event type (it would break strict parsers), no epoch bump (it would close every member's live stream in every channel the person wrote in, and cursors stay valid because seq does not change). A browser tab that is open when an erasure runs shows the old text until it reloads.

### Routes

Account routes sit on `hostApi` beside `/memberships`, need a signed-in browser session, and never accept host authority.

| Route                                                               | Body                                                                                               | Result                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/account/erasures`                                      |                                                                                                    | this account's open requests and those cancelled in the last 30 days; membership items include the community name. A completed membership erasure no longer appears: nothing links it to the account any more |
| `POST /api/v1/account/erasures`                                     | `{ kind: 'membership', communityId, password? }` or `{ kind: 'account', confirmEmail, password? }` | `201 { erasure }`; a repeat while one is open returns the open one with `200`                                                                                                                                 |
| `POST /api/v1/account/erasures/:id/cancel`                          |                                                                                                    | `200 { erasure }`; `409` after `execute_after`                                                                                                                                                                |
| `GET /api/v1/communities/:communityId/owner/former-members?cursor=` |                                                                                                    | owner only: inactive members (id, display name, handle, `removedAt`, origin, open erasure if any), 50 per page                                                                                                |
| `POST /api/v1/communities/:communityId/owner/erasures`              | `{ memberId, password? }`                                                                          | owner only; target must be inactive and not erased (`409` otherwise)                                                                                                                                          |
| `GET /api/v1/communities/:communityId/owner/erasures`               |                                                                                                    | owner only: requests for this community (owner-made and self-made), states and times only                                                                                                                     |
| `POST /api/v1/communities/:communityId/owner/erasures/:id/cancel`   |                                                                                                    | current owner; owner-made requests only                                                                                                                                                                       |
| `GET /api/v1/communities/:communityId/channels/:id/redactions`      |                                                                                                    | see above                                                                                                                                                                                                     |

`kind: 'membership'` needs a `members` row for this account in that community, active or not; that is how a person erases a community they already left. `confirmEmail` must equal the account's email exactly.

```ts
CommunityWireErasureSchema = z.strictObject({
  id,
  kind: z.enum(['membership', 'account']),
  requestedBy: z.enum(['self', 'owner']),
  state: z.enum(['scheduled', 'running', 'completed', 'cancelled']),
  communityId: id.nullable(),
  communityName: z.string().nullable(), // account routes only, the person's own memberships
  memberId: id.nullable(),
  executeAfter: timestamp,
  createdAt: timestamp,
  completedAt: timestamp.nullable(),
  cancelledAt: timestamp.nullable(),
});
```

### Worker

`src/erasure-worker.ts`, started from `main.ts` beside the deletion worker, polls every 30 seconds for `erasure_requests` with `state IN ('scheduled','running') AND execute_after <= now() AND next_attempt_at <= now()`, claiming one with `FOR UPDATE SKIP LOCKED`, sets `running`, runs the procedure, and marks `completed`. A failure records an error class (`^[A-Z][A-Z0-9_]{0,63}$`, never a message), increments `attempts`, and backs off with the existing cleanup backoff. Blob bytes are removed by the existing pending-deletion cleanup, which already retries.

### Backup re-application

A host restoring a backup taken before some erasures must run them again. Each completed membership erasure logs `{"event":"community.member_erased","communityId":…,"memberId":…}` and each completed account erasure logs `{"event":"community.account_erased","userId":…}` (a random id, not an email). `pnpm --filter @dorkos/community erasure:reapply < ids.txt` reads `member <communityId> <memberId>` and `account <userId>` lines, runs `eraseMembership` or `eraseAccount` for each with the web service stopped (like `recover-password`), and prints only counts. The self-hosting docs describe this.

### Data model changes (migration: next free number at build time)

- `erasure_requests(id uuid PK, kind CHECK IN ('membership','account'), requested_by CHECK IN ('self','owner'), user_id text NULL REFERENCES "user"(id) ON DELETE SET NULL, community_id uuid NULL REFERENCES communities(id), member_id uuid NULL, requested_by_member_id uuid NULL, parent_request_id uuid NULL REFERENCES erasure_requests(id), state CHECK IN ('scheduled','running','completed','cancelled'), execute_after, created_at, started_at, completed_at, cancelled_at, attempts int, next_attempt_at, last_error_class)`, with checks: `kind='account'` ⇒ `community_id`, `member_id` NULL and `requested_by='self'` (its `user_id` is set until the account row is deleted); `kind='membership'` ⇒ `community_id`, `member_id` set and `user_id` NULL, so no completed request links an account to a community; `requested_by='owner'` ⇒ `requested_by_member_id` set; `execute_after >= created_at`; completed and cancelled timestamps match the state. Composite tenant foreign keys `(community_id, member_id)` and `(community_id, requested_by_member_id)` to `members(community_id, id)`. Partial unique indexes: one open (`scheduled`/`running`) membership request per `(community_id, member_id, requested_by)` and one open account request per `user_id`. Due index on `(next_attempt_at, execute_after) WHERE state IN ('scheduled','running')`.
- `entry_redactions(id bigint GENERATED ALWAYS AS IDENTITY PK, community_id, channel_id, entry_id, created_at)` with tenant foreign keys to `channels` and `entries`, index `(channel_id, id)`.
- `entries.erased_at timestamptz NULL`.
- `members.erased_at timestamptz NULL`; `members.user_id` drops `NOT NULL`; the user-presence check becomes `user_id IS NOT NULL OR erased_at IS NOT NULL OR (origin='imported' AND NOT active)`. If the import migration (host-operator phase 4) has not landed, the check is `user_id IS NOT NULL OR erased_at IS NOT NULL`, and the import migration later widens it. Whichever lands second owns the combined check.
- `communities.content_version integer NOT NULL DEFAULT 1 CHECK (content_version > 0)`; `export_archives.content_version integer NULL` (NULL for rows written by old code, which commit refuses only if an erasure has happened since the migration: treat NULL as 1).
- The tenant deletion worker deletes the tenant's `entry_redactions` and `erasure_requests` rows before its members.
- `src/schema.ts` mirrors all of it.

### Code structure

- `apps/community/src/erasure.ts`: `eraseMembership`, `eraseAccount`, `rewriteHandleTokens(text, handles)` (pure, unit-tested), tombstone constants.
- `apps/community/src/erasure-worker.ts`: polling and backoff.
- `apps/community/src/routes/erasures.ts`: account and owner routes; registered from `app.ts` (`hostApi` for account routes, `communityApi` for owner routes).
- `apps/community/src/routes/entries.ts`: redaction feed.
- `apps/community/src/routes/members.ts`, `routes/host.ts`, `routes/administration.ts`: the three window guards.
- `apps/community/src/routes/exports.ts`: `LEFT JOIN`, `content_version`.
- `apps/community/src/erasure-reapply.ts` + `package.json` script.
- `packages/shared/src/community-wire.ts`: the schemas above and `REAUTH_REQUIRED`.
- Browser: `Manage.tsx`, `CommunityChooser.tsx`, `CommunityAdministration.tsx`.
- Phase 2: `apps/server/src/services/communities/remote/` (feed client, mirror update), `packages/db` (mirror column), `apps/server/src/services/search/` (room re-index on update).

### Phase 2: DorkOS installations drop their cached copies

- `community_room_mirrors` gains `redaction_cursor text NULL`.
- The remote subscription runtime pages the redaction feed for each mirrored room after every `replay_complete` and every 15 minutes while subscribed, from the stored cursor.
- For each item whose entry is in `community_mirror_entries`: in one SQLite transaction, update `room_entries.body` and `mentions`, and `community_mirror_entries.entry_json`, `author_display_name`, `author_kind`; if the entry is a tombstone, set the external author's display name in `authors` to `Erased member` / `Erased agent`. Store the new cursor.
- The mirror never dispatches a local agent for a redaction (it is not a new post).
- Message search only indexes above a per-room watermark and never sees an in-place update (`row-frontier.ts`), so after a page that changed rows, drop that room's frontier so the room is re-indexed from the start. Add a per-container invalidation to the frontier store if none fits.
- A `404` from the feed marks the connection as not supporting it until restart, logged once.

## User Experience

Copy follows the `writing-for-humans` skill. Every screen that starts an erasure says what it cannot reach.

**Erase me from one community** (`Manage.tsx`, in the "Leave community" panel's place for non-owners, and reachable from the host root for communities the person already left):

> **Erase your messages here**
> In 72 hours, we'll remove your name, messages, files, and your agents' messages from {community}. Your messages stay in their place in conversations, marked "This message was erased." You can cancel until then.
> We can't reach copies people already downloaded, or copies on members' computers that are offline.
> [Enter {community}] [Confirm password] **Erase my messages**

Owners see "Transfer ownership or delete the community before you erase your messages here." While scheduled, the community shows a banner to that person only: "Your messages here will be erased on {date}. **Cancel**".

**Delete your account** (`CommunityChooser.tsx`, host root):

> **Delete your account**
> In 72 hours, we'll delete your account on this host and erase your name, messages, files, and agents from every community here, including ones you left. You can cancel until then by signing in.
> We can't reach copies people already downloaded, or copies on members' computers that are offline.
> [Enter your email] [Confirm password] **Delete my account**

If the person owns a community, the button is replaced by: "You own {names}. Transfer ownership or delete {it/them} first." The host root lists scheduled erasures with their dates and a **Cancel** button each.

**Owner: erase a former member** (`CommunityAdministration.tsx`, "Former members" section):

> Former members (list: name, handle, left or removed on {date}) → **Erase** →
> Erase {name}'s messages? In 72 hours, we'll remove their name, messages, files, and agents' messages from this community. Do this when they ask you to. You can cancel until then.
> [Confirm password] **Erase**

Errors are plain sentences from the server (`409`: "That person is already scheduled for erasure."). Nothing in the UI names who asked for an erasure except to the person who asked.

## Testing Strategy

Integration tests run against real PostgreSQL and the filesystem BlobStore, using `tenancy-test-harness.ts`. Each test carries a purpose comment.

### Acceptance criteria that discriminate

**AC-1 — Residue scan (the core test).** Seed two communities on one host. In community A, person P (display name `Zephyrine Quill`, email `zq-canary@example.test`) joins, pairs an installation named `zq-canary-laptop`, enrolls an agent `ZQ Canary Bot` (handle derived, `local_agent_id` `zq-canary-local`), and posts: a top-level message containing `canary-text-1`, a reply in someone else's thread, an agent post containing `canary-text-2`, a message with an attachment named `zq-canary.txt` whose bytes contain `canary-bytes-1`, an unbound upload, and uses idempotency key `zq-canary-key`. Member Q posts `@<P's handle> thanks`, a message mentioning P's agent, and a code block containing `@<P's handle>`. Q creates a personal export and the owner creates an owner export, both within their hour. In community B, P is also a member with the same canaries. Then:

- **Control (before):** a scan finds every canary in its expected place. The scan enumerates **every table and every column** of type `text`, `varchar`, `text[]`, `json`, and `jsonb` in the `public` schema from `information_schema.columns` (never a hand list), plus every object in the BlobStore, plus the log output captured during the test. It also searches for the SHA-256 hex of each of P's entry payloads. If any canary is not found before erasure, the test fails: a canary the scan cannot see proves nothing.
- **After P erases their membership in A and the worker and blob cleanup finish:** no canary appears in any column of any row with `community_id = A`, in any blob that belonged to A, or in the log, except the ones listed in AC-10. Community B still contains every canary (tenant isolation).
- **After P deletes their account:** no canary appears anywhere on the host: no row in any table, no blob, no log line. The `"user"`, `session`, `account`, and `verification` rows are gone.
- A new table added later that stores a person's data fails this test until erasure covers it, because the scan enumerates the schema.

**AC-2 — Thread shape.** After erasure, every entry of P and P's agent in A has the same `id`, `seq`, `parent_entry_id`, `thread_root_entry_id`, and `created_at` as before; `GET /channels/:id/entries` returns them with text `This message was erased.`, author `Erased member` / `Erased agent`, `mentions: []`, `attachments: []`; each response parses with the unchanged `CommunityWireEntrySchema`. Q's reply to P's erased message still lists it as parent; a thread query on P's erased root still returns Q's replies. A page cursor and a live-stream resume cursor taken before erasure still work after it (`seq` unchanged, no `410`).

**AC-3 — Mentions.** Q's `@<handle> thanks` reads `@[erased] thanks`; the code-block handle reads `@[erased]`; Q's mention of P's agent reads `@[erased]`; no `entry_mentions` row targets P or P's agent; Q's own retry of their original post with its original idempotency key and payload returns `200` with the entry (payload hash unchanged). A new member can now take P's old handle, and posting `@<old handle>` resolves to the new member only.

**AC-4 — Files and exports.** Every attachment blob of P in A is gone from the BlobStore after cleanup, and `GET /attachments/:id` answers `404`. Q's personal export and the owner's export made before erasure answer `404` at `GET /exports/:id`, and their blobs are gone. An owner export whose snapshot was read before the erasure's first content change and whose commit is forced after it (test hook between snapshot and commit) is refused with `409` and leaves no blob. An owner export made after erasure contains P's husk with `email: null` and no canary.

**AC-5 — Window and cancel.** A request is `scheduled` with `executeAfter` exactly 72 hours after `createdAt`. Before that, nothing about P changes (a full-table digest of community A is equal before the request and just before execution), P can still post, and cancel returns `cancelled` with the digest still equal. After `executeAfter`, cancel answers `409`. The worker never runs a cancelled request.

**AC-6 — Authority.** Each erasure route answers `403` for: a host API key, a host operator's session acting on a community where they are not a member, a connection grant bearer, an agent bearer, an admin erasing another member, a member erasing another member, and the owner erasing an active member (`409`). The owner erasing themselves is `403`. Account deletion is `403` for a host operator and `409` for an owner of an active community. A person cannot cancel an owner-made request, and an owner cannot cancel a self-made one.

**AC-7 — Window guards.** During P's open erasure: transfer of ownership to P is `409`; an owner claim redeemed by P's account (account erasure) is `409`; an owner with an open account erasure cannot cancel their community's deletion (`409`). A membership P gains during an account-erasure window is erased at execution.

**AC-8 — Crash and repeat.** Kill the worker after each of steps 1 to 6 (test hook), restart it, and the final state equals an uninterrupted run (same digest). Running `eraseMembership` twice, or the reapply CLI after completion, changes nothing. The person and the owner both requesting erasure of the same membership completes both requests with one erasure.

**AC-9 — Every lifecycle.** An erasure scheduled in A completes when A is `archived`, `held` (once the host-operator hold exists), `suspended`, and `deletion_pending` at execution time. In a `deletion_pending` community P owns, account erasure husks P's owner row (no name, handle, or `user_id`) and the tenant deletion later removes the rest.

**AC-10 — Imported and historical.** The owner can erase an imported historical member (once import exists) and a member who left before this feature shipped. The only data the scan is allowed to find after erasure is data the design leaves on purpose, each asserted explicitly so nobody later claims otherwise: a free-text display name typed by another member (`thanks Zephyrine`), and audit rows holding the husk's id.

**AC-11 — Redaction feed.** Before erasure the feed for a channel is empty; after it, the feed returns one item per changed entry with its current projection (tombstones and Q's rewritten entry), each parsing with the strict schemas, and nothing for channels the caller cannot read (`404`, same as history). A cursor from another channel is `410`.

**AC-12 — Backup re-application.** Take a database and BlobStore snapshot, erase P, restore the snapshot, run `erasure:reapply` with the logged ids: the AC-1 scan passes again, and P's restored account is deleted.

**AC-13 — DorkOS installation (phase 2).** A DorkOS test server paired to community A mirrors a channel with P's messages and indexes it. Control: the local SQLite file (every table and column enumerated from `sqlite_master`) and a message search for `canary-text-1` both find it. After erasure and one feed sync: neither the SQLite file nor search finds any canary, the mirrored entries show the tombstone and the rewritten mention, the external author record reads `Erased member`, and no local agent was dispatched. Against a community server without the route (`404`), sync logs once and changes nothing.

### Other tests

- Unit: `rewriteHandleTokens` (end-of-token rule with `.`, `-`, `_`, trailing punctuation, case, handles that are prefixes of other handles such as `zq` vs `zq2`, code blocks, quotes); tombstone payload hash; reauthentication rule (password account, OAuth-only account with fresh and stale sessions).
- Browser: the three flows render their "cannot reach" sentence, the owner sees the transfer message instead of the button, cancel updates the banner.
- Migration: old code against the new schema (backout), and the user-presence check under both orders of this migration and the import migration.

### Mocking strategy

None for PostgreSQL or the BlobStore (real ones, as the tenancy suites do). The clock is injected into the worker so the 72-hour window is tested without waiting. Phase 2 uses a real community server from the community test harness and a real DorkOS SQLite database.

## Performance Considerations

- Batches of 500 rows per transaction keep lock time on a community short; posting in that community waits at most one batch.
- The mention step pre-filters with a regular expression on `text` within one community. It is a scan of that community's entries, run once per erasure in the background; the index on `entry_mentions(community_id, mentioned_member_id)` covers the mention rows.
- The redaction feed reads `entry_redactions` by `(channel_id, id)`; pages are at most 100.
- Phase 2 re-indexes a whole room after a change. Rooms are bounded by community history; erasures are rare.

## Security Considerations

- Erasure is irreversible after the window, so every request reauthenticates, and the account form also asks for the email typed exactly. The window is the defense against a mistake or a stolen session; a stolen password defeats it, as it defeats every account control.
- Host authority cannot reach any erasure route, the owner lists, or the redaction feed, and no host route reports erasures. Host usage figures change as bytes are removed; that is all the host can see.
- The owner can erase only former members, so erasure is not a faster way to silence a current member than removal already is.
- Nothing about who asked is visible to other members. The audit trail says an erasure happened, to a husk id.
- The redaction feed carries the same content the caller could already read through history, and nothing else.
- Log lines carry ids only. Error classes are codes, never messages.
- The random husk handle is unguessable, so it cannot be used to find the person again.

## Documentation

- `docs/guides/communities.mdx`, "Export or leave": add erasing your messages and deleting your account, with the 72-hour window and the plain list of what erasure cannot reach.
- The self-hosting docs: how erasure works on a host, that host operators cannot erase for a person, how to help someone who cannot sign in (offline password recovery), and `erasure:reapply` after restoring a backup.
- A changelog fragment in `changelog/unreleased/` for each phase.
- `specs/community-host-operator-api/02-specification.md`: its Open Question 7 points here; its hold section lists erasure as allowed while held; its import section notes the shared `LEFT JOIN` and check change.

## Implementation Phases

- **Phase 1 — Community server erasure (host launch blocker).** Migration; procedure, worker, routes, guards, export changes, redaction feed, reapply CLI, browser flows, docs. AC-1 to AC-12.
- **Phase 2 — DorkOS installations honor redactions.** Feed client, mirror update, search re-index. AC-13. Not a host launch blocker: it reaches copies on members' own machines, which the host does not control. Phase 1 writes `entry_redactions` from its first erasure, so phase 2 catches up on every erasure that happened before it shipped.

### Backout

- Phase 1: before any erasure has run, revert the code; the migration stays and old code ignores the new tables and columns. After one has run, the supported path is forward-fix: old code's owner export inner-joins `"user"` and would silently drop every husk, leaving entries whose author is missing from the archive. If a revert is unavoidable, cancel every open request first and accept that owner exports are incomplete until the fix ships.
- Phase 2: revert the code; the mirror column stays and is ignored.

## Open Questions

None open. Resolved while specifying:

- ~~What does a thread show in place of an erased message?~~ (RESOLVED) **Answer:** the row stays with its position and thread links; text `This message was erased.`, author `Erased member` or `Erased agent`, no mentions, no attachments. **Rationale:** keeps threads, cursors, and unread counts working and fits the strict wire unchanged.
- ~~Per community or the whole account?~~ (RESOLVED) **Answer:** both, from one per-membership procedure; the account form erases every membership on the host, then the account. **Rationale:** accounts are host-wide and authority is per membership (ADR `260920-192429`).
- ~~Are the person's agents' posts erased?~~ (RESOLVED) **Answer:** yes. **Rationale:** the person owns the agent, and its posts carry their data.
- ~~Mentions in other people's messages?~~ (RESOLVED) **Answer:** mention rows deleted, `@handle` tokens rewritten to `@[erased]`, free text untouched. **Rationale:** the handle is released and must not come to name someone else; free-text matching would be guesswork.
- ~~Attachments?~~ (RESOLVED) **Answer:** hard delete through the blob inventory.
- ~~Exports?~~ (RESOLVED) **Answer:** every live export in the community is deleted; an export snapshotted before an erasure cannot commit; downloaded files cannot be recalled, and the UI says so.
- ~~Audit trail?~~ (RESOLVED) **Answer:** kept, ids and action names only.
- ~~Immediate or a grace period?~~ (RESOLVED) **Answer:** 72 hours, cancellable, nothing changes until it runs. **Rationale:** a cancel is a full undo; 72 hours is well within "without undue delay".
- ~~Host hold, import, owner export?~~ (RESOLVED) **Answer:** erasure runs in every lifecycle state; imported historical members are erased by the owner; the owner export keeps husks with `email: null`.
- ~~Can the owner erase a removed member's content on request?~~ (RESOLVED) **Answer:** yes, for any member who is no longer active, with reauthentication and the same window.
- ~~How do OAuth-only accounts reauthenticate?~~ (RESOLVED) **Answer:** a session less than 5 minutes old. **Rationale:** they must be able to erase themselves at launch; the general OIDC reauthentication follow-up (host-operator spec Open Question 5) can replace this later.
- ~~Should the live stream announce erasures?~~ (RESOLVED) **Answer:** no; a separate pull-only feed. **Rationale:** a new event type breaks strict parsers in every older installation, and an epoch bump closes everyone's streams for no gain.

## Related ADRs

- `260923-134614` — Erasure tombstones a member's history in place and deletes everything else (draft, from this spec)
- `260923-134616` — Member erasure belongs to the person and the community owner, after a 72-hour cancellable window (draft, from this spec)
- `260920-201101` — Separate community retention from permanent tenant deletion (the same window-and-worker shape, one level down; host authority stays out)
- `260920-192429` — Scope host accounts through immutable community memberships (account erasure spans every membership)
- `260923-121712` — Host hold and host-started deletion (draft, host-operator spec; erasure is allowed while held)
- `260923-121153` — Import restores an owner export with historical members (draft, host-operator spec; shares the nullable `user_id` and the `LEFT JOIN`)

## References

- DOR-2247 — this specification
- DOR-2243 and `specs/community-host-operator-api/02-specification.md` (Open Question 7, migrations 0012 to 0015)
- `specs/community-tenancy-contract/02-specification.md`, `specs/community-administration-contract/02-specification.md`
- `apps/community/src/routes/members.ts`, `routes/entries.ts`, `routes/exports.ts`, `routes/events.ts`, `routes/host.ts`, `routes/administration.ts`, `mentions.ts`, `handles.ts`, `auth.ts`, `schema.ts`, `deletion-worker.ts`, `recover-password.ts`, `storage/`
- `packages/shared/src/community-wire.ts`
- `apps/server/src/services/communities/remote/mirror-store.ts`, `apps/server/src/services/search/registry.ts`, `row-frontier.ts`
- GDPR Art. 17 (right to erasure; "without undue delay"); California Civil Code §1798.105 (CCPA right to delete)
