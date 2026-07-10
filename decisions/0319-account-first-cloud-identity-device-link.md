---
number: 319
title: 'Account-first cloud identity: instances device-link to DorkOS accounts'
status: accepted
created: 2026-07-02
spec: accounts-and-auth
superseded-by: null
---

# 0319. Account-first cloud identity: instances device-link to DorkOS accounts

## Status

Accepted

## Context

DorkOS Cloud will be both a coordination layer over local instances (remote access, relay/mesh, notifications, marketplace identity) and, possibly later, hosted instances. Agents run on the user's machine with the user's Claude subscription, so the local instance is not going away; identity must span machines. Treating cloud identity as "hosted multi-user DorkOS" (the n8n model) would leave local and cloud identities as unrelated systems and pose a painful SQLite-to-Postgres user-migration problem the moment a self-hoster adopts Cloud.

## Decision

The DorkOS account (Better Auth on dorkos.ai, Neon Postgres) is the durable identity; local instances **attach to it** via an RFC 8628 device-link flow (Better Auth `deviceAuthorization` plugin) and receive a scoped, revocable instance API key, registered in an `instance` table with a dashboard for revocation (Tailscale/GitHub-CLI model). Local logins remain instance-scoped and independent; **identities are never migrated between local and cloud databases**. Product naming: "DorkOS account"; the local credential is just "login".

## Consequences

### Positive

- Dissolves the identity-migration problem entirely: linking replaces migration.
- One durable identity for marketplace, notifications, relay, and future hosted instances; local instances keep working fully offline and unlinked.
- Instance tokens are scoped API keys, individually revocable from the account dashboard.

### Negative

- Two Better Auth deployments (local + cloud) to operate and keep upgraded.
- Users can hold two credentials (a local login and a DorkOS account), which product copy must keep un-confusing; contextual prompts carry that burden.
