---
id: 260923-121151
title: Host-set community limits are caps with typed errors, and usage exposes only enforcement aggregates
status: draft
created: 2026-09-23
spec: community-host-operator-api
superseded-by: null
---

# 260923-121151. Host-set community limits are caps with typed errors, and usage exposes only enforcement aggregates

## Status

Draft (auto-extracted from spec: community-host-operator-api)

## Context

A host serving many communities cannot bound what one of them consumes: there is no member or storage limit, the only per-person agent cap is host-wide, and reaching it answers `429 RATE_LIMITED`, which tells a client to retry a request that can never succeed. The host also cannot see usage, and the administration contract kept counts and latest-message data out of the host list to protect content privacy.

## Decision

We will store host-set per-community limits for active members and stored bytes, plus a per-member override of the agents-per-person limit, and enforce them inside the transactions that grow each quantity. A cap answers `409` with one code per limit (`MEMBER_LIMIT_REACHED`, `STORAGE_LIMIT_REACHED`, `AGENT_LIMIT_REACHED`); rate windows keep `429`. Stored bytes are summed from the existing tenant blob inventory rather than a maintained counter; exports never count. Lowering a limit only stops growth and never deletes. A separate host usage read, single or paged across communities, returns exactly the aggregates needed to enforce limits and find abandoned communities: active member and agent counts, stored bytes by purpose, limits, and the UTC date of the newest post.

## Consequences

### Positive

- Clients can show a precise, non-retrying message for each cap.
- One source of truth for bytes; no counter to drift.
- Owners can always export, whatever their storage use.
- Hosts can plan capacity and reclaim abandoned communities without reading content.

### Negative

- Admissions and uploads serialize per community while a limit is set.
- The usage read narrows, but does not keep, the administration contract's "no counts, no latest-message data" rule for the host plane.
- A per-member override is keyed by a member UUID the host must be given, since the host has no member directory.
