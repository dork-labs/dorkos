---
slug: community-administration-contract
number: 260920-201100
created: 2026-09-20
status: ideated
linear-issue: DOR-2175
project: Community Administration
---

# Community administration lifecycle

## Brief

Define how an independent multi-community host is operated without confusing host maintenance authority with community ownership. Cover host metadata and creation, owner settings, transfer, archive/restore, suspension, deletion, exports, audit history, agent teardown, and safe management UI behavior.

The accepted tenancy contract in DOR-2171 and PR #1943 is the authority foundation. It is accepted and queued, not merged at the time of this artifact. This contract consumes its immutable community UUID, host-wide account, tenant membership, `pending_owner | active | suspended` baseline, and host-operator separation without changing them.

## Existing behavior

- One community is created during bootstrap and exposed through a public metadata route.
- Owners can promote/demote members, transfer ownership after password reauthentication, export the whole community, and must transfer before leaving.
- Removing or leaving revokes agents and grants, but the singleton implementation deletes the whole host session; DOR-2171 already replaces that with tenant-scoped revocation.
- Community name and description exist in PostgreSQL. There is no community settings write surface, icon, archive, host list/create flow, or permanent deletion state machine.
- Attachments and one-hour exports live behind `BlobStore`; failed blob deletion already has retry infrastructure.

## Options considered

### Lifecycle shape

1. One growing enum for every owner and operator combination. Simple queries, but produces states such as `suspended_archived` and makes future policy changes combinatorial.
2. Owner lifecycle plus an orthogonal operator suspension. Clearer intent, but contradicts DOR-2171's frozen `suspended` community state.
3. **Selected:** retain the frozen state enum and store the pre-suspension state explicitly. `suspended` always blocks member traffic; `resume_state` restores only the prior `active` or `archived` state.

### Permanent deletion

1. Immediate synchronous cascading delete. Easy to request, unsafe for object-store partial failure and impossible to cancel.
2. Indefinite soft deletion. Recoverable, but it is not permanent deletion and retains private content forever.
3. **Selected:** a seven-day owner-cancelable deletion window followed by bounded, retry-safe blob cleanup and tenant-row deletion. A content-free operational tombstone remains for 30 days, then expires.

### Settings authority

1. Let admins change every setting. Fast delegation, but it grants destructive authority beyond today's role model.
2. Owner-only everything. Safe, but unnecessarily blocks routine presentation maintenance.
3. **Selected:** owner controls identity-sensitive, admission, ownership, archive, and deletion actions. Owner and admin may edit description and icon. Members read visible metadata only.

## Product principles

- Every destructive prompt names the community and uses its immutable ID behind the display name.
- Archive is reversible and keeps data. Delete is delayed, explicit, and eventually removes it.
- Host suspension is an operational safety control, not a way to read content or appoint an owner.
- Revocation happens when access ends, before cleanup finishes.
- A failed cleanup remains visible and retryable; it never widens the delete query to another tenant.
- Standalone local accounts remain complete. No DorkOS Cloud service is required.

## Result

Proceed to SPECIFY and DECOMPOSE. Implementation belongs to DOR-2176 and DOR-2177; cross-tenant lifecycle proof belongs to DOR-2178.
