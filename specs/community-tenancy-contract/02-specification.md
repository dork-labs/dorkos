---
slug: community-tenancy-contract
number: 260920-192428
created: 2026-09-20
status: specified
linear-issue: DOR-2171
project: Multi-Community Hosting
---

# Community tenant identity, authorization, and migration contracts

**Status:** Approved

**Date:** 2026-09-20

## Overview

One independent Community host may serve several communities. Better Auth accounts and sessions belong to the host; memberships, roles, people, agents, channels, entries, files, invitations, grants, quotas, exports, and audit events belong to exactly one immutable community UUID. Standalone local identity remains complete and has no DorkOS Cloud dependency.

An existing single-community deployment upgrades in place. Its current community UUID and every existing domain ID remain unchanged. Unqualified v1 routes continue as a single-community compatibility alias until a second community exists.

## Goals

- Give one host account zero, one, or many community memberships.
- Make the immutable community UUID explicit at every browser, API, credential, database, and background-job boundary.
- Preserve one owner per community while separating host operation from community content authority.
- Provide a Slack-like community switcher without making names or domains identity.
- Upgrade and, while still single-community, back out existing deployments without data loss.
- Prove isolation with an adversarial two-community matrix.

## Non-goals

- DorkOS Cloud accounts, billing, organization policy, or control-plane resources.
- Cross-host identity federation, shared sessions across hosts, or moving a membership between hosts.
- Vanity slugs or per-community custom domains.
- Database-per-community provisioning.
- Implementing the contract in DOR-2171; this work item freezes the design and task graph.

## Identity model

### Host account

The Better Auth `user`, `session`, `account`, and `verification` records remain host-wide. Email uniqueness is per host. A valid session authenticates an account but grants no community access by itself.

### Community and membership

`communities.id` is the immutable tenant ID. Names and descriptions are mutable display data. A membership has its own immutable UUID and is unique on `(community_id, user_id)`. The same account may have distinct display names, handles, roles, active states, agents, grants, and read positions in different communities.

Every `active` or `suspended` community has exactly one active `owner` membership. A `pending_owner` community has none and serves no member traffic until its owner claim is redeemed. `admin` and `member` remain community roles. Ownership transfer is transactionally scoped to one community.

### Host operator

`host_operators(user_id, created_at, revoked_at)` is a separate host-level authority. It can list community metadata, create a community, suspend or resume it, and perform documented host recovery operations. It does not authorize channel, entry, file, member-directory, invitation, agent, export, or audit-content access. A host operator needs an ordinary membership for those actions.

The first-install bootstrap is host-scoped and atomically creates the first host operator, first community, and its owner membership. Creating later communities requires a live host operator: it creates a `pending_owner` community with its final UUID and a community-specific owner-claim grant; the operator may claim it or hand it to another host account. An ordinary owner-claim grant can target and transition only `pending_owner → active`; it cannot be issued or redeemed for an `active` or `suspended` community. Bootstrap grant rows carry an explicit purpose, and only the one-time first-install purpose may lack a community UUID.

There is no online host-operator path to replace a lost owner or mint membership in an existing community. Because the database invariant prevents a healthy active or suspended community from losing its sole owner, such a state is corruption or disaster recovery: stop every service replica and restore or repair from audited offline evidence. A future online break-glass flow requires its own named contract, explicit authorization ceremony, credential revocation, and per-community audit design before implementation.

## Canonical addresses and selection

- Browser: `/c/:communityId/...`.
- Tenant API: `/api/v1/communities/:communityId/...`.
- Discovery returns the host identity plus the communities visible to the current account. Unauthenticated discovery exposes only host capabilities, never a private community directory.
- Invitation URLs, pairing approval URLs, SSE endpoints, cursors, and callback state carry or are cryptographically bound to the immutable community UUID.
- The browser stores the last active community as a convenience only. The path is authoritative, and switching communities cancels tenant queries and streams before opening the next tenant.

A local DorkOS connection starts from a canonical community link, not an origin-only guess. The connection request accepts exactly the host root URL for the single-community compatibility path or `/c/:communityId` for an explicit tenant. The pinned-origin parser validates HTTPS or loopback, credentials, port, and the exact path shape; extracts and validates the UUID; then pins and resolves only the origin for transport. It does not send the browser path to the remote API, follow redirects, or relax DNS rebinding checks. The qualified pairing start names that UUID, and the returned browser approval URL uses the same canonical community path. A root URL may obtain a UUID only from the existing singleton discovery response when exactly one community row exists. It never enumerates tenants. Existing stored origin-only connections migrate through that rule; ambiguous origins require the person to paste a canonical community link.

Current unqualified `/api/v1/*` routes and the root browser path are compatibility aliases. They resolve only when exactly one community row exists; a suspended row then returns its typed unavailable response. With zero communities they enter first-install bootstrap. With more than one they return a typed `COMMUNITY_SELECTION_REQUIRED` response or redirect to the chooser. They never select the first row, infer from the most recent membership, or accept a client header as authority.

The remote Community adapter pins one configured community UUID and uses only qualified endpoints. Its local `CommunityRef` remains a separate, locally minted connection identity.

## Authorization contract

The request pipeline is:

1. Parse and validate `communityId` from the canonical path or a cryptographically bound one-use token.
2. Authenticate the host account, personal grant, or agent credential.
3. Resolve the credential to an active membership or agent in that same community.
4. Load the requested object with both its ID and `community_id`, or join through a parent whose community is checked in the same statement.
5. Apply the community role, channel membership, ownership, and scope rule.
6. Recheck the same tenant-bound credential inside write transactions after locks are acquired.

The application returns `404` for cross-community object IDs on member-facing routes so it does not reveal that the object exists. A host operator still cannot bypass this rule. Cookie sessions, personal grants, agent credentials, invitations, pairing codes, cursors, idempotency keys, and export downloads are all bound to one community.

Database constraints backstop the service checks. Tenant-critical relations use redundant `community_id` plus composite foreign keys or equivalent validated constraints so a member or agent from community A cannot be attached to a channel, entry, invite, handle, audit event, cursor, file, or export in community B. Global opaque token hashes and blob keys may remain globally unique, but their rows still carry tenant ownership.

## Schema contract

### Add or change

- remove `communities.singleton` and its check/unique constraints;
- replace unique `members.user_id` with unique `(community_id, user_id)`;
- add `host_operators` keyed by `user_id`;
- add community lifecycle state (`pending_owner`, `active`, `suspended`), with active as the migrated default;
- add a purpose and nullable `community_id` to bootstrap grants, constrained so only first-install grants are host-scoped and every owner-claim grant names a community; add non-null `community_id` to connection pairings;
- add explicit `community_id` to tenant-owned tables that currently infer it: connection grants, invite uses, pending admissions, channel members, agent credentials, agent channel members, entries, attachments, export archives, read cursors, and quota windows;
- replace `entries.mentions` with ordered `entry_mentions(community_id, entry_id, ordinal, mentioned_member_id, mentioned_agent_id)` rows, constrained so exactly one typed target is present and tenant-qualified composite foreign keys prove that the referenced human or agent shares the entry tenant; replace `export_archives.channel_ids` with ordered `export_archive_channels(community_id, export_archive_id, channel_id, ordinal)` rows whose composite foreign keys prove that each channel shares the archive tenant;
- add tenant-qualified blob inventory and reservation rows for every attachment and export object write. A reservation records the immutable `community_id`, generated opaque blob key, purpose, and lifecycle before bytes are stored; committing the content reference re-locks the community and verifies its lifecycle version in the same database transaction;
- retain it on communities, members, invites, channels, agents, handles, and audit events;
- use composite unique keys needed by composite foreign keys and validate that all referenced rows share one community.

`pending_blob_deletions` may remain a host-operational queue, but each new cleanup item must retain immutable tenant ownership through the blob inventory. Cleanup candidates log only redacted tenant context. Before enabling a second community, reconcile the complete managed object namespace while ownership is still unambiguous: referenced attachment and export objects receive the singleton community's ownership, and legacy pending deletions backed by their durable queue rows become tenant-qualified cleanup inventory. A valid-looking opaque key alone is not ownership evidence. Every otherwise-unexplained entry blocks readiness without deletion and produces a redacted report with manual ownership-resolution instructions. If the BlobStore cannot exhaust its authoritative listing, an object is ambiguous, or cleanup ownership cannot be established, second-community creation remains disabled.

### Entry points that must change

| Current assumption                      | Required contract                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| first community row                     | explicit path UUID; singleton alias only under the compatibility rule                                                                                         |
| member by `user_id`                     | member by `(community_id, user_id)`                                                                                                                           |
| owner exists anywhere                   | one owner in the selected community                                                                                                                           |
| bootstrap grant without tenant          | explicit host-first-install purpose only; later owner claims bind the pre-created community UUID                                                              |
| invite redemption locks user alone      | lock `(community_id, user_id)` and reactivate only that membership                                                                                            |
| pairing starts without tenant           | pairing starts for an explicit community and every later step verifies it                                                                                     |
| membership removal deletes all sessions | revoke that membership's grants, agents, streams, and pairings; keep host sessions and other memberships                                                      |
| password recovery picks a membership    | recover the host account once, revoke all host sessions and every membership-derived credential across all its communities, and audit each affected community |
| unqualified export/file lookup          | include the selected community in lookup and archive ownership                                                                                                |
| process-global cleanup/rate key         | include community where the resource or limit is tenant-owned                                                                                                 |
| one remote community per origin         | one adapter instance pins one server-minted community UUID                                                                                                    |

## Browser experience

After sign-in, a person with one membership enters it directly. A person with several sees the last active community when still authorized and can switch from a persistent community menu showing names and their role. A person with no memberships sees invitations they can redeem and no community content.

Leaving or being removed from one community returns the person to another available community or the chooser. It does not sign them out of the host. Suspended communities remain visible to host operators but refuse member traffic with a typed unavailable response.

## Migration and compatibility

Ship an expand, backfill, validate, contract migration before qualified routes can create a second community:

1. **Expand:** add nullable tenant columns, host-operator and lifecycle structures, composite candidate keys, blob inventory/reservations, and indexes without dropping current constraints. New attachment and export writes reserve tenant ownership before storing bytes and recheck lifecycle before committing their reference.
2. **Backfill:** when one community exists, copy its UUID through every tenant-owned relation by its current foreign-key chain, normalize each mention and export-channel array element into its ordered tenant-qualified child row, promote its active owner account to host operator, and bind viable pairing rows to it. Mention backfill resolves each UUID to exactly one human or agent in the entry's community and rejects missing or human/agent-ambiguous targets rather than dropping them. Reconcile every managed blob as verified referenced inventory or tenant-qualified cleanup. With zero communities, perform no tenant row backfill and accept only an empty managed namespace. Unexplained objects remain untouched and require manual ownership resolution. Invalidate outstanding legacy bootstrap grants so the new purpose-bound preflight reissues them safely; reject migration if any other row or managed object is ambiguous or orphaned.
3. **Validate:** accept zero communities with no tenant-owned rows or managed objects, or one existing community with one active owner and a complete tenant-qualified blob inventory; assert no cross-tenant relation, no unexpected null tenant key, no unidentified managed object, and unchanged domain row counts, stable IDs, and file checksums. Add and validate composite constraints.
4. **Contract:** make tenant columns non-null, replace singleton/member uniqueness constraints, and enable qualified routes plus the singleton alias.

Startup remains migration-first. The release must run correctly before first bootstrap and with exactly one community before any API enables creation of a second. Back up PostgreSQL and object storage at one recovery point before migrating a populated host.

The second-community creation gate reads durable singleton reconciliation state with a monotonic generation. Legacy-shaped inserts, updates, and deletes to inferred-owner tables, plus unmanaged cleanup work, increment the generation and mark the state dirty through commit-deferred invalidators that touch only the generation row after domain and inventory writes finish. Reconciliation applies its reversible inventory work before locking and comparing that generation, so the compatibility fence has one domain/inventory-to-generation lock order. Before reconciliation, the operator must quiesce every old application instance that can write the database or object namespace; a database session census is only supporting evidence because it never proves that an old writer cannot reconnect. Reconciliation holds the current-writer fence across an authoritative BlobStore listing, records only the generation it validated, and fails if a concurrent write changes it. A later second-community transaction must repeat the complete listing, require this exact-generation state, and require the task 1.3 non-null/composite constraints. A storage implementation without listing support cannot pass this gate automatically. DOR-2176 may extend the inventory to icons and deletion progress, but it does not defer this attachment/export foundation.

Backout is supported only while the host still has one community and no multi-membership account. Restore the coordinated pre-migration backup or run a tested reverse migration that reinstates the singleton constraints. After a second community or second membership exists, automated downgrade is forbidden because choosing which tenant data to discard would be destructive; recovery is forward-fix or export/split into separate hosts.

## Adversarial verification matrix

For communities A and B, use one account that belongs to both, one account only in A, one only in B, one host operator with no membership, one agent per community, and private channels/files in both.

Verify every endpoint family and transaction against:

- A session on an A path with a B object ID returns `404` and causes no write.
- A host session without membership cannot read A or B content.
- a host operator cannot issue or redeem an owner claim, membership, or content credential for active or suspended A; only pending-owner B accepts its one tenant-bound claim.
- Role and ownership changes in A do not change B.
- Leaving/removal in A preserves the account session and B membership, but immediately ends A streams and credentials.
- Password recovery revokes the account’s sessions and all derived credentials across A and B, with per-community audit evidence.
- A grants, agents, invites, pairings, cursors, idempotency keys, exports, and download IDs cannot be replayed in B.
- a canonical A connection link extracts A's UUID without listing B, while an origin-only request fails once both exist; redirects, DNS changes, encoded-path variants, credentials, and unexpected path segments remain rejected.
- an A entry cannot mention a B human or agent, and an A export archive cannot contain a B channel, including through direct SQL writes and migrated array data; human and agent mention order survives migration.
- concurrent requests cannot approve a pairing, redeem an invite, transfer ownership, or attach a cross-tenant relation after a tenant/credential recheck.
- community switching closes A SSE before B data enters cache; reconnect cursors cannot cross tenants.
- compatibility routes work with one community and fail closed immediately after the second community row is created, including while that row awaits its owner.
- migration preserves all IDs, row counts, entry order, file checksums, membership, and the existing public origin.

## Observability and operations

Structured logs and metrics include community UUID for tenant work, but never email, token, invite, credential, or file URL. Host-wide jobs record a bounded candidate count and tenant-safe outcome. Operators can reconcile the number of communities, memberships, channels, entries, attachments, and pending cleanup rows without reading content.

Backups remain host-wide unless the storage engine supports a proven tenant export. Community export is a user feature and is not represented as a full disaster-recovery backup.

## Implementation phases

1. Expand and backfill the schema with migration verification and rollback gates.
2. Introduce tenant context, qualified API, host operations, and fail-closed authorization.
3. Convert admission and credentials, qualify discovery and the remote adapter from canonical community links, add the chooser, and retire every singleton lookup.
4. Run the adversarial matrix and single-deployment compatibility/recovery proof.

## Open questions

All decisions required for implementation are resolved in this specification. Vanity slugs and per-community custom domains remain separate future work.

## Related ADR

- `260920-192429` — Scope host accounts through immutable community memberships

## References

- DOR-2171 — Specify tenant identity, authorization and migration contracts
- `apps/community/src/schema.ts`
- `apps/community/src/data.ts`
- `apps/community/src/app.ts`
- `apps/community/src/routes/`
- `apps/community/migrations/`
- `apps/server/src/services/communities/remote/remote-community-adapter.ts`
- `specs/community-adapter/02-specification.md`
