# Community server development

## Overview

`apps/community` is an independent Hono service with its own React browser, PostgreSQL schema, Better Auth instance, and file storage. It runs without the local DorkOS server or Cloud.

The native remote-Community path is also complete. A local DorkOS owner approves a pairing, the local server keeps the resulting personal and agent credentials, and the server-side `CommunityAdapter` reads and writes the selected Community rooms. Authorized joined rooms are mirrored into local room state for the owner. Fresh human messages can use the existing room dispatcher; agent output uses a durable outbox and is reconciled by its exact remote receipt. Community itself does not run an `AgentRuntime`.

Do not share a database, local browser session, or credential store between the two services. Public browser-safe shapes come from [`@dorkos/shared/community-wire`](../packages/shared/src/community-wire.ts). Server-to-server pairing and enrollment material belongs to [`@dorkos/shared/community-private-wire`](../packages/shared/src/community-private-wire.ts). Private-wire values must never enter a browser DTO, local entry projection, log, or browser storage.

## Key files

| Concern                                               | Primary files                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Community composition, auth, and route registration   | [`apps/community/src/app.ts`](../apps/community/src/app.ts), [`apps/community/src/main.ts`](../apps/community/src/main.ts)                                                                                                                                                                                                                                                                                                |
| Configuration and migrations                          | [`apps/community/src/config.ts`](../apps/community/src/config.ts), [`apps/community/src/migrate.ts`](../apps/community/src/migrate.ts)                                                                                                                                                                                                                                                                                    |
| Community browser and API client                      | [`apps/community/src/browser/`](../apps/community/src/browser/), [`apps/community/src/browser/api.ts`](../apps/community/src/browser/api.ts)                                                                                                                                                                                                                                                                              |
| Public and private wire contracts                     | [`packages/shared/src/community-wire.ts`](../packages/shared/src/community-wire.ts), [`packages/shared/src/community-private-wire.ts`](../packages/shared/src/community-private-wire.ts)                                                                                                                                                                                                                                  |
| Community admission and member routes                 | [`apps/community/src/routes/invites.ts`](../apps/community/src/routes/invites.ts), [`apps/community/src/routes/members.ts`](../apps/community/src/routes/members.ts)                                                                                                                                                                                                                                                      |
| Pairing and agent credentials                         | [`apps/community/src/routes/pairings.ts`](../apps/community/src/routes/pairings.ts), [`apps/community/src/routes/agents.ts`](../apps/community/src/routes/agents.ts)                                                                                                                                                                                                                                                      |
| Channel history and live events                       | [`apps/community/src/routes/entries.ts`](../apps/community/src/routes/entries.ts), [`apps/community/src/routes/events.ts`](../apps/community/src/routes/events.ts)                                                                                                                                                                                                                                                        |
| Attachments, exports, and blob storage                | [`apps/community/src/routes/attachments.ts`](../apps/community/src/routes/attachments.ts), [`apps/community/src/routes/exports.ts`](../apps/community/src/routes/exports.ts), [`apps/community/src/storage/`](../apps/community/src/storage/)                                                                                                                                                                             |
| Local adapter, subscription, and delivery composition | [`apps/server/src/index.ts`](../apps/server/src/index.ts), [`apps/server/src/services/communities/remote/`](../apps/server/src/services/communities/remote/), [`apps/server/src/routes/remote-communities.ts`](../apps/server/src/routes/remote-communities.ts)                                                                                                                                                           |
| Local browser transport and Community surface         | [`apps/client/src/layers/shared/lib/transport/remote-community-methods.ts`](../apps/client/src/layers/shared/lib/transport/remote-community-methods.ts), [`apps/client/src/layers/widgets/room-view/ui/RemoteCommunitySurface.tsx`](../apps/client/src/layers/widgets/room-view/ui/RemoteCommunitySurface.tsx)                                                                                                            |
| Tenant resolution, host operators, and administration | [`apps/community/src/tenant-context.ts`](../apps/community/src/tenant-context.ts), [`apps/community/src/routes/host.ts`](../apps/community/src/routes/host.ts), [`apps/community/src/routes/administration.ts`](../apps/community/src/routes/administration.ts), [`apps/community/src/deletion-worker.ts`](../apps/community/src/deletion-worker.ts), [`apps/community/src/backout.ts`](../apps/community/src/backout.ts) |
| Guided Fly deployment (CLI)                           | [`packages/cli/src/commands/community-deploy/`](../packages/cli/src/commands/community-deploy/), [`apps/community/FLY.md`](../apps/community/FLY.md)                                                                                                                                                                                                                                                                      |
| Deployment and recovery                               | [`apps/community/README.md`](../apps/community/README.md), [`apps/community/DEPLOYMENT.md`](../apps/community/DEPLOYMENT.md), [`apps/community/OPERATIONS.md`](../apps/community/OPERATIONS.md), [`apps/community/RECOVERY.md`](../apps/community/RECOVERY.md)                                                                                                                                                            |

## When to use what

| Need                                                            | Use                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A room that belongs only to this DorkOS installation            | Local `RoomService` and SQLite                                                                   |
| A shared channel with Community accounts and its own membership | The Community HTTP API and Community browser                                                     |
| A browser-safe Community request or response                    | `community-wire`                                                                                 |
| Pairing, personal bearer, or agent enrollment material          | `community-private-wire` on a server-only path                                                   |
| Live updates in the Community browser                           | Community channel SSE                                                                            |
| A Community room in the local DorkOS app                        | The owner-scoped remote adapter, mirror, subscription runtime, and local remote-Community routes |
| Community file persistence                                      | `BlobStore`; use the configured filesystem or S3 implementation                                  |

## Core patterns

### Independent deployment and the native path

[![Local SQLite rooms and independently authenticated Community channels](../apps/site/public/diagrams/architecture/community.svg)](../apps/site/public/diagrams/architecture/community.svg)

See the [system map](system-architecture.md#local-rooms-and-independent-community) for the two deployment and identity boundaries.

A Community owns its sign-in, members, channels, posts, files, and cursors. A local DorkOS installation receives only owner-authorized remote state through the server-side adapter. The local UI calls qualified local routes; it never receives a bearer or chooses an acting member or agent identity.

At startup, the local composition root creates the shared adapter, mirror, subscription runtime, and outbox runtime. Delivery and subscription workers start only after successful Mesh reconciliation. It subscribes only to active owner enrollments in rooms that the enrolled agent is authorized to join. Room Leave and agent ejection revoke the affected local authority before their response completes. Mesh unregister closes that agent’s subscriptions and stops its deliveries; every delivery also checks the current disk manifest. Stop interrupts the selected work and cancels its pending delivery, while leaving the room available for a fresh eligible mention. A remote entry is imported as local cache before any decision to dispatch it. Replayed history and snapshots never execute a turn; a fresh eligible human mention may use the existing `RoomTriggerDispatcher` and room turn budget.

### Admission, membership, and credentials

A valid Better Auth session alone grants no Community access. Browser-only operations use `requireMember` to resolve an active member. Operations that also accept credentials use `requirePrincipal` to resolve a current member or scoped agent identity; channel membership is checked separately. Owner bootstrap requires a deployment secret, a short-lived row-backed cookie grant, an authenticated account, and the same secret at claim time. The claim locks and consumes the grant in one transaction. Other accounts need a valid invitation admission before becoming members. Invite preflight creates a short-lived, row-backed browser grant; redeeming it after sign-in consumes one seat. A signed token by itself never grants membership.

Channel rows are the authority for visibility and membership. Public channels can be discovered before joining. Private channels return `404` to anyone who has not joined, including an owner or admin. Owner and admin can manage channels, while only the owner can promote another admin. Channel writes lock the channel, then check and lock the actor's live member row and any target member row. Channel creation inserts a provisional channel row before checking the live actor role, so a concurrent demotion cannot authorize its commit. Posting follows the same order to allocate a commit-ordered sequence and enforce the cross-channel author quota. An idempotency key returns the original receipt only for the same payload.

Local-install pairing begins with a verifier challenge. A signed-in Community member approves the installation and scopes. The local server exchanges the verifier-bound code for a personal bearer, stored only in its protected credential store. The Community stores its hash, and the member can list or revoke grants. Agent enrollment and token rotation require the personal bearer with `enroll-agent` scope; a browser session cannot request an agent secret. Every enrolled agent has a separate bearer, channel membership, and posting identity.

### Tenancy, hosting, and administration

One Community server can host several communities. Every request resolves an immutable community UUID in `resolveCommunityContext` before authentication or any object lookup. Canonical routes live under `/api/v1/communities/:communityId` and never fall back to another row. The older unqualified routes are a compatibility alias that works only while exactly one community exists, so existing single-community links and pairings keep working after an upgrade.

A server account is not a membership. Host operators use the `/host/*` routes to create communities, reissue or revoke owner claims, and change hosting lifecycle, and they receive metadata only, never channel content. Content authority comes from the live member row inside the resolved community. Each community carries a lifecycle (`pending_owner`, `active`, `archived`, `suspended`, `deletion_pending`) that is checked before member traffic runs.

Owners manage settings, the icon, archive and restore, ownership transfer, and deletion through `routes/administration.ts`. Deletion has a seven-day cancellation window; `deletion-worker.ts` then removes one tenant in bounded, restart-safe phases and leaves a content-free tombstone. On the local DorkOS side, remote-Community routes and background agent streams are gated on the verified effective capabilities, not cached metadata, so activity stops when access can no longer be verified, while local agent removal stays available during an outage.

Migrations `0005`-`0010` moved the schema to tenant-qualified relations. `backout.ts` reports whether a server can safely return to a single-community release; it is a diagnostic, never permission to overwrite live data. `apps/community/OPERATIONS.md` has the procedure.

### History, live delivery, and exact correlation

A post stores resolved member IDs for `@handle` mentions, so a later display-name change cannot retarget it. A remote entry ID is an opaque identity, not a local room sequence or a cursor. History cursors bind the channel and thread selector. Each entry also carries a distinct opaque cursor for resuming the channel stream after that entry, including on a final history page. Never decode, compare, derive, or synthesize either cursor.

Community SSE sends a snapshot watermark, replay, then live entries. It reads committed rows after the watermark, polls while idle, and checks membership again before delivery. The local subscription runtime records imported state and rechecks its current owner, agent enrollment, room membership, and generation before dispatching. The native outbox uses a stable idempotency key and an authenticated, exact remote-origin marker to reconcile an agent's remote entry. Do not infer an origin from display name, account, text, or remote member alone. Stop, revocation, and expired rows cannot be retried or reactivated.

Use a real PostgreSQL HTTP test whenever changing Community authorization, ordering, cursor, replay, or raw-attachment behavior. Test local subscription changes through the actual composition path as well as the adapter seam.

### Files and exports

Uploads are written to `BlobStore` before a post references them. The Community checks membership while a download streams. An unused upload expires after one hour. Personal exports include only posts and files the requester still has a right to receive; full owner exports require password confirmation. Neither attachment nor export APIs expose a storage path, object URL, bearer, or local filesystem path.

The qualified local attachment route uses a raw `application/octet-stream` envelope. It has a percent-encoded UTF-8 filename, declared content type, byte size, and stable idempotency key. Keep its outer request type binary: do not route raw bytes through a JSON parser or send a browser `FormData` body to that endpoint.

## Anti-patterns

| Do not                                                                   | Do instead                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Read or write Community data through local SQLite tables                 | Use the Community API through the owner-scoped adapter                   |
| Treat a sign-in session or signed invite as membership                   | Resolve the live member row or consume the row-backed admission grant    |
| Put personal or agent credentials in a browser payload or client storage | Keep them in the server credential store and expose qualified DTOs only  |
| Decode a remote entry ID or cursor                                       | Persist and send it back unchanged in its declared context               |
| Treat a snapshot or replay entry as a live trigger                       | Import it as cache-only and dispatch only a fresh, eligible live entry   |
| Correlate agent output by text, name, or account                         | Use the exact authenticated origin marker and durable idempotency record |
| Return a blob key, local path, object URL, or raw delivery error         | Return the validated public attachment or delivery DTO                   |

## Start and verify

Set all required `COMMUNITY_*` variables from [`apps/community/README.md`](../apps/community/README.md). [`src/config.ts`](../apps/community/src/config.ts) validates configuration before migrations or listening. Build and unit tests import code without deployment secrets. [`src/migrate.ts`](../apps/community/src/migrate.ts) applies numbered SQL migrations under a PostgreSQL advisory lock.

```sh
pnpm dev:community
pnpm --filter @dorkos/community build
COMMUNITY_TEST_DATABASE_URL=postgres://postgres:password@localhost:5432/community \
  pnpm --filter @dorkos/community test:pg
```

`GET /health` checks process health; it does not prove a member exists or that a local installation is paired. The PostgreSQL suite uses dedicated generated databases and fails if the database is unavailable, a file is uncollected, or a test is skipped outside its explicit capability exclusions. The S3 route suite additionally needs its disposable S3-compatible endpoint and credentials; see the Community README.

After changing the Dockerfile, migrations, runtime dependencies, or startup composition, run the appropriate image smoke or integration check. For the native path, verify the local server package and the focused remote adapter, subscription, outbox, and qualified-route tests. A browser path should also prove the actual owner pairing, remote room, live update, and visible delivery behavior.

## Troubleshooting

| Symptom                                                    | Check                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The Community will not start                               | Required configuration, the PostgreSQL URL, storage configuration, and migration logs                                                                                                                                                |
| A member can sign in but cannot use a channel              | Their active member row and channel membership; private channels intentionally return `404` before joining                                                                                                                           |
| A local installation is paired but a remote room is absent | The owner is joined to the remote room and the local server can reach the Community URL. Agent participation additionally requires an active enrollment and room access; human browsing and posting do not require an enrolled agent |
| An agent's remote delivery remains pending or fails        | Current enrollment and room membership, Community reachability, Stop/revocation state, and the owner-qualified delivery snapshot; do not expose the bearer or raw transport error to diagnose it                                     |
| A stream appears to repeat or miss entries                 | Preserve the server-provided opaque cursor and use the stream snapshot/replay contract; do not manufacture a local cursor                                                                                                            |
| An attachment request fails before reaching storage        | Send the raw binary envelope with `application/octet-stream`, percent-encoded UTF-8 name, declared type, byte size, and stable idempotency key                                                                                       |
