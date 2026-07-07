---
id: 260707-010337
title: Adopt Better Auth's admin plugin plus an append-only audit log for cloud account management
status: accepted
created: 2026-07-06
spec: cloud-account-management
superseded-by: null
---

# 260707-010337. Adopt Better Auth's admin plugin plus an append-only audit log for cloud account management

## Status

Accepted

## Context

The `apps/site` cloud identity core (accounts-and-auth, #268) opened self-registration but had no way
to manage the accounts strangers would create: no ban/disable, no session revocation, no GDPR/CCPA
erasure, no forensic record of privileged actions. Three ways to build it: (a) hand-roll admin
queries over the Drizzle client; (b) adopt Better Auth's first-party `admin` plugin; (c) buy a hosted
console (WorkOS/Clerk). Passwords and API keys are stored hashed, so any management path that reaches
around Better Auth into raw SQL cannot set or read those secrets and risks diverging from Better
Auth's own state machine (ban semantics, session revocation, id generation).

## Decision

Adopt the Better Auth **`admin` plugin** as the single management surface, and add an **append-only
`audit_log`** table alongside it.

- Every privileged mutation goes through Better Auth's typed API (`auth.api.*` / `authClient.admin.*`),
  never raw SQL. A single `admin` role grants all operations (no custom access controller for v1);
  `adminUserIds` (env) is the break-glass bootstrap for the first admin.
- **Ban is the default reversible lever**; hard delete is reserved for erasure. Because `banUser`
  revokes sessions but not API keys, a hook additionally disables the banned account's keys so its
  linked instances stop authenticating.
- `audit_log` records actor/action/target/reason/metadata/time for every admin action and self-serve
  deletion. It has **no foreign key to `user`** so the trail survives a hard-deleted (GDPR-erased)
  account, and it stays hard-isolated from install telemetry (no shared identifier crosses the
  account ↔ telemetry boundary).
- Managed consoles (WorkOS/Clerk) are explicitly deferred — the buy-not-build lever if admin burden
  grows (`research/20260702_auth_providers_oss_vs_managed.md`), not the v1 path.

## Consequences

- Better Auth stays the single source of truth for identity state; ban/impersonate/revoke are correct
  by construction rather than re-implemented.
- The audit log outliving erased accounts is a deliberate retention choice: the record that an action
  happened is not itself personal data we are obligated to erase, and it is required for abuse
  forensics. It is telemetry-isolated and never stores secrets.
- The admin plugin adds columns to `user`/`session` (`role`, `banned`, `banReason`, `banExpires`,
  `impersonatedBy`) via one additive migration.
- Auditing rides Better Auth's `hooks.after` middleware (the only server seam, since the client calls
  the admin endpoints directly), which couples it to that hook's context shape — covered by
  integration tests over the in-memory adapter.
- A tailored `/admin` console and scheduled cleanup jobs are follow-ups on top of this foundation.
