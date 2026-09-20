---
id: 260920-192429
title: Scope host accounts through immutable community memberships
status: proposed
created: 2026-09-20
spec: community-tenancy-contract
superseded-by: null
---

# 260920-192429. Scope host accounts through immutable community memberships

## Status

Proposed

## Context

The Community service currently has host-level Better Auth accounts but permits one community and one membership per account. Most domain rows already carry or derive a community UUID. Serving several communities from one independent host needs a stable tenant boundary without making DorkOS Cloud an identity dependency or forcing one database per community.

## Decision

Keep accounts and sessions host-wide, and authorize community work through memberships unique on `(community_id, user_id)`. Use the immutable server-minted community UUID in canonical browser and API paths, with mutable names used only for display. A local connection selects a private tenant from that canonical link while pinning only its validated origin for transport. Store several communities in one PostgreSQL database with mandatory row scoping and tenant-consistency constraints; normalize array-valued tenant references so PostgreSQL can validate each relation. Represent host operators separately from community roles; operational authority alone cannot read community content or mint membership in an existing community. Ordinary owner claims activate only newly created `pending_owner` communities; lost-owner repair is offline unless a later break-glass contract is approved.

Existing unqualified routes are a compatibility alias only while one community exists. Existing installations retain every identity during an expand, backfill, validate, contract migration, and a never-bootstrapped database also upgrades cleanly. Automated downgrade ends once the host contains a second community or a multi-membership account.

## Consequences

### Positive

- A standalone host can offer a familiar community switcher while keeping local identity complete.
- Community IDs survive renames and domain moves.
- The design extends the tenant columns already present instead of adding per-tenant database orchestration.
- Host maintenance authority stays separate from member content access.
- Current single-community deployments keep their IDs, URLs, and behavior during upgrade.

### Negative

- Every request, credential, background job, and relational write must carry and verify tenant context.
- Shared-database isolation depends on both disciplined queries and database constraints, so the adversarial matrix is a permanent release gate.
- Unqualified compatibility routes become unavailable after a second community is created.
- Downgrading after real multi-community use requires export or splitting hosts rather than an automatic reverse migration.
