---
id: 260707-122350
title: The admin console lives in apps/site now, extracted to its own app only on a trigger
status: accepted
created: 2026-07-07
spec: null
superseded-by: null
---

# 260707-122350. The admin console lives in apps/site now, extracted to its own app only on a trigger

## Status

Accepted

## Context

Cloud account management (DOR-187) shipped the Better Auth `admin` plugin, an audit log, and self-serve delete/export **inside `apps/site`** (the marketing + docs + account site on dorkos.ai, Neon Postgres). The admin _backend_ is therefore already bound to `apps/site`: one Better Auth instance, one database connection, one session cookie scoped to `dorkos.ai`, and one deploy pipeline that runs `db:migrate`. DOR-193 adds the operator **console UI** on top of it.

The question is only where that UI lives:

- **A — a guarded `/admin` route group inside `apps/site`.**
- **B — a separate `apps/admin` Next app** (e.g. `admin.dorkos.ai`), its own deploy.

B's isolation is genuinely attractive (separate deploy cadence, separate bundle, admin off the public marketing domain, tighter network exposure). But B's costs land squarely on the identity core, which is single-instance and cookie-bound to `apps/site`:

- **Auth**: the session cookie is on `dorkos.ai`. A separate app must scope the cookie to `.dorkos.ai` + add its origin to `trustedOrigins`/CSRF, or run a second Better Auth instance, or call site's admin API with a forwarded/service token.
- **Database**: both apps hit the same Neon DB, so a split forces either shared code across two deployments (the same auth engine running twice) or an internal HTTP API, and it splits ownership of `db:migrate` (a real race risk, cf. the migration-ledger gotcha hit while shipping DOR-187).
- **Infra**: another Vercel project, domain/DNS, and env secrets, for an internal tool at pre-launch with ~0 users and a single (founder) admin.

## Decision

**Build the admin console as a guarded `/admin` route group inside `apps/site` now, structured so a later extraction to `apps/admin` is a UI move rather than a rewrite. Extract only when a concrete trigger appears.**

- The console is its own Feature-Sliced slice (`features/admin`); the reusable logic (`db/`, `lib/auth.ts`, `instance-service`, `audit-service`, `account-service`) stays app-agnostic so it can migrate toward `packages/*` and be imported by a future `apps/admin` unchanged.
- The surface is hardened in-place: a server-side `role=admin` (or `ADMIN_USER_IDS`) gate on every `/admin/**` route, `noindex`, and (recommended, ops-level) Vercel deployment/route protection or an IP/SSO gate on `/admin`.

**Extraction triggers** (any one): non-founder staff/support need admin but not deploy access; admin grows dashboards/bulk ops that bloat the marketing app or need a different deploy cadence; meaningful real user data warrants network-level isolation for defense-in-depth; or compliance requires the admin surface off the public domain.

## Consequences

- Fast, low-infra path today: the console reuses the existing Better Auth instance, session cookie, DB, design system, and deploy — no cross-subdomain auth, no service-to-service plumbing, no second migration owner.
- The admin UI is served from the public `dorkos.ai` domain and shares a deployment with the marketing site. This is an accepted, bounded blast radius at ~0 users; the in-place guard + `noindex` + optional deployment protection mitigate it, and the extraction triggers above bound how long we accept it.
- Keeping `features/admin` isolated and the identity/db core app-agnostic is load-bearing: it is what makes the future split cheap. New admin code must not entangle marketing-only concerns, and the identity core must not import `features/admin`.
- Revisit this ADR when an extraction trigger fires; the successor is a separate `apps/admin` app on its own origin with a `.dorkos.ai`-scoped cookie (or its own Better Auth instance over the shared DB) and a single, explicit `db:migrate` owner.
