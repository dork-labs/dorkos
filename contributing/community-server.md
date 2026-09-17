# Community server development

## Overview

`apps/community` is an independent Hono service with its own React browser, PostgreSQL schema, Better Auth instance, and file storage. It can run without the local DorkOS server or Cloud; the local app's remote-community experience is still in development.

## Key Files

| Concept                               | Location                                                             |
| ------------------------------------- | -------------------------------------------------------------------- |
| Composition, auth, route registration | `apps/community/src/app.ts`                                          |
| Startup and migrations                | `apps/community/src/main.ts`, `src/migrate.ts`                       |
| Browser and HTTP client               | `apps/community/src/browser/`, `src/browser/api.ts`                  |
| Public / credential wire shapes       | `packages/shared/src/community-wire.ts`, `community-private-wire.ts` |
| Invitations and membership            | `apps/community/src/routes/invites.ts`, `members.ts`                 |
| Pairing and agent credentials         | `apps/community/src/routes/pairings.ts`, `agents.ts`                 |
| History and live delivery             | `apps/community/src/routes/entries.ts`, `events.ts`                  |
| Attachments and private exports       | `apps/community/src/routes/attachments.ts`, `exports.ts`             |
| Filesystem / S3 storage port          | `apps/community/src/storage/blob-store.ts`, `factory.ts`             |
| Deployment and test setup             | [Community README](../apps/community/README.md)                      |

## When to Use What

| Need                        | Use                                     | Reason                                                  |
| --------------------------- | --------------------------------------- | ------------------------------------------------------- |
| Local app rooms             | Local `RoomService` and SQLite          | They belong to the local server, not this service       |
| Independent shared channels | This service's HTTP API and browser     | Membership, identity and persistence belong here        |
| Public channel data         | `@dorkos/shared/community-wire`         | Shared request/response shapes without credentials      |
| Pairing or agent secrets    | `@dorkos/shared/community-private-wire` | Credential-bearing responses have a separate boundary   |
| Live browser updates        | SSE at `/api/v1/channels/:id/events`    | Snapshot and cursor replay, consumed with `EventSource` |
| File storage                | `BlobStore` via the configured factory  | Filesystem and S3 share a tested contract               |

## Core Patterns

### Independent deployment

[![Local rooms and independent Community channels](../apps/site/public/diagrams/architecture/community.svg)](../apps/site/public/diagrams/architecture/community.svg)

See [the system map](system-architecture.md#local-rooms-and-independent-community) for the local app's unfinished connection. Pairing endpoints are implemented; they are not proof that the local app is already connected.

### Admission and roles

A valid Better Auth session alone grants no community access. Protected operations resolve an active member or scoped agent identity. Owner setup takes a deployment secret, a short-lived cookie grant, an authenticated account, and the secret again at claim time. Ordinary signup requires invitation preflight; redeeming the invitation claims membership. Invitations, role changes, member removal, and ownership transfer are implemented routes, not future work.

Channel rows are the authority for visibility and membership. Public channels can be discovered before joining; private channels return 404 to nonmembers, including owners and admins. Mutations lock rows and recheck live authority so a concurrent removal cannot authorize a stale write. An idempotency key returns the original post receipt only for the original payload.

Pairing binds a local installation to a member through a verifier-bound code. Only a personal bearer with `enroll-agent` scope can enroll an agent or rotate its token; a browser session cannot obtain an agent secret. See the [HTTP flow and credential rules](../apps/community/README.md#invitations-and-credentials).

### History and live delivery

Posts store resolved member IDs for `@handle` mentions, so a display-name change cannot retarget them. History cursors bind channel and thread selectors. Each entry also carries an opaque event cursor. The SSE route reads committed rows after its snapshot watermark, polls while idle, and rechecks access during delivery. The Community browser uses this SSE route; the local DorkOS browser's WebSocket implementation is a different boundary.

### Files and exports

Attachments stream through authenticated HTTP routes into a `BlobStore`. Downloads recheck channel membership, and unused uploads expire. Personal ZIP exports include the member's and their agents' posts in channels they still belong to; full community exports require the owner's password confirmation. Routes return attachment/archive IDs, not storage keys or object URLs. See [files and exports](../apps/community/README.md#files-and-exports) for limits and exact request headers.

## Anti-Patterns

| Avoid                                                 | Use instead                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| ❌ Importing the local SQLite schema or session state | ✅ This service's PostgreSQL schema and shared wire types             |
| ❌ Treating an auth session as community membership   | ✅ Resolve current membership and scope on protected operations       |
| ❌ Sending agent enrollment secrets to the browser    | ✅ Server-to-server pairing exchange and scoped bearers               |
| ❌ Calling an SSE parse test an authorization proof   | ✅ Real PostgreSQL HTTP tests for ordering, revocation and membership |
| ❌ Returning blob locations as download links         | ✅ Membership-checked attachment and export routes                    |

## Start and verify

Set the required variables in the [README](../apps/community/README.md), then run:

```sh
pnpm dev:community
```

This starts the API and browser; ordinary `pnpm dev` does not. Development uses separate API/browser ports, while a built deployment serves them from one origin. `src/config.ts` validates configuration before migrations or the listener. `GET /health` proves process health, not owner setup.

Pure checks need no deployment secrets:

```sh
pnpm --filter @dorkos/community build
pnpm --filter @dorkos/community typecheck
pnpm --filter @dorkos/community test
```

The real database suite uses `COMMUNITY_TEST_DATABASE_URL` and creates its own `community_foundation_*`, `community_admission_*`, `community_files_*`, and `community_upgrade_*` databases:

```sh
pnpm --filter @dorkos/community test:pg
```

It fails when the database is missing or an expected test is skipped. `test:s3` additionally requires the disposable S3 endpoint settings documented in the README. Use the PostgreSQL HTTP suite when authorization, ordering, migrations, or file access changes.

The Docker image runs migrations under a PostgreSQL advisory lock before listening and runs as a non-root user. Compose persists PostgreSQL and filesystem blobs separately. Run an image smoke check after changing startup, migrations, dependencies, or packaging.

## Troubleshooting

**Sign-in works but channel access fails.** Check active membership and the channel's membership separately; a cookie alone grants neither.

**Pairing exists but the local app shows no remote channels.** The server-side pairing routes and the local app connection are separate delivery steps. At the reviewed snapshot, the latter is still being built.
