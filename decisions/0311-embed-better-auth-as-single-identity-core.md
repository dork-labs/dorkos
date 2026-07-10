---
number: 311
title: Embed Better Auth as the single identity core across OSS and Cloud
status: accepted
created: 2026-07-02
spec: accounts-and-auth
superseded-by: null
---

# 0311. Embed Better Auth as the single identity core across OSS and Cloud

## Status

Accepted

## Context

DorkOS needs authentication in both its self-hosted OSS edition (npm CLI, Express 5, SQLite, must work offline) and the future DorkOS Cloud (Next.js on Vercel, Neon Postgres). A managed auth provider in the OSS core would break offline/self-hosted use and couple every self-hoster to a vendor contract (LobeHub migrated off Clerk onto Better Auth in Jan 2026 for exactly this reason). Standalone OSS identity servers (Keycloak, Zitadel, Logto, Authentik) require a separate long-running service plus Postgres, disproportionate for an npm-distributed local tool. Adversarially-verified research (`research/20260702_auth_providers_oss_vs_managed.md`) found Better Auth to be the only maintained embeddable TypeScript auth library: Lucia was deprecated in 2025, and Auth.js/NextAuth is in maintenance mode under Better Auth's own stewardship.

## Decision

Embed Better Auth (MIT, ^1.6) as the identity core in both editions: mounted in `apps/server` on the Drizzle/SQLite stack for local instances, and in `apps/site` on Drizzle/Neon Postgres for DorkOS accounts. Plugins provide per-user API keys and the RFC 8628 device flow now, and organizations later. Rejected alternatives: managed auth in the OSS core; a standalone identity server; Auth.js/Lucia.

## Consequences

### Positive

- One auth codebase and mental model across OSS and Cloud; no per-MAU costs; works offline; data stays in the user's database.
- Exact stack match (TypeScript, Express 5, Drizzle, SQLite/Postgres) with documented integrations; org/2FA/passkey growth path is free plugins, not new systems.

### Negative

- We own security patching, session hardening, and abuse protection with no vendor SLA.
- Better Auth is a fast-moving v1.x dependency; its own enterprise SSO/SCIM plugin maturity is unproven (claim refuted in research), so enterprise federation still needs WorkOS (ADR-0321).
