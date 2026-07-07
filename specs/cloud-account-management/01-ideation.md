---
slug: cloud-account-management
number: 260706-234037
created: 2026-07-06
status: ideation
---

# Cloud Account Management: Better Auth Admin Plugin + Self-Serve Delete/Export

**Slug:** cloud-account-management
**Author:** Dorian (via /flow)
**Date:** 2026-07-06
**Tracker:** DOR-187

---

## 1) Intent & Assumptions

- **Task brief:** The `apps/site` (dorkos.ai) **cloud** Better Auth instance now has open self-registration (email/password with required verification + GitHub/Google), shipped in spec #268 (accounts-and-auth, PR #76, on `main`). There is no admin surface and no self-serve account lifecycle. Add: (1) the Better Auth `admin` plugin (ban/unban, impersonate, revoke sessions, set password, list/search, delete), (2) self-serve "Delete my account" + data export in `/account` for GDPR/CCPA, (3) audit logging for admin actions + impersonation, (4) — later/separate — a tailored `/admin` console over the plugin + `instance-service`.
- **Assumptions:**
  - Scope is the **cloud** identity core only (`apps/site`, Neon Postgres). The **local** self-hosted server (`apps/server`, SQLite, owner-only single-user, managed via `dorkos auth` CLI) is explicitly out of scope: it already stamps `role: 'owner'` and has no open registration.
  - The existing `onDelete: cascade` chain (`session`, `account`, `apikey`, `instance` → `user`) means deleting a `user` row atomically removes sessions, OAuth links, API keys, and linked instances. A deleted user's instances lose their link on the next heartbeat (missing row → 401 → unlink), per `handleHeartbeat`.
  - Better Auth is the single source of truth for identity mutation. Password + API-key secrets are hashed, so management goes **through Better Auth's typed API**, never raw SQL (raw SQL is break-glass only).
  - **Timing gate (from the issue, load-bearing):** implement _when cloud self-registration opens to real users_, not before (currently ~0 users; YAGNI). This spec is authored now so the design is ready; the EXECUTE decision is a **human gate**. `agent/ready` was deliberately withheld at TRIAGE so nothing auto-dispatches this to EXECUTE.
- **Out of scope:**
  - The local `apps/server` SQLite auth instance and `dorkos auth` CLI.
  - The tailored `/admin` console UI (scope item 4) — designed here as a **follow-up**, not built in the MVP phase. The MVP is: admin plugin enabled + minimal admin capability reachable, self-serve delete/export, audit logging.
  - Migrating identities between the local and cloud instances (never happens by design).
  - Payment/billing/subscription state (no such tables exist yet).
  - Buying a managed admin (WorkOS/Clerk hosted console) — noted as the buy-not-build lever in `research/20260702_auth_providers_oss_vs_managed.md`, not this spec's path.

## 2) Pre-reading Log

- `apps/site/src/lib/auth.ts`: the cloud Better Auth factory `createAuth(database)` + lazy singleton `getAuth()`. Plugins today: `deviceAuthorization`, `apiKey({ enableMetadata: true })`, `instanceRegistry()`. `emailAndPassword.requireEmailVerification: true`; GitHub + Google social. A `/device/token` after-hook swaps the device session for a scoped API key. **No `admin` plugin, no `accountLinking` config, no `user.deleteUser` config today.** This is the single file where the admin plugin registers.
- `apps/site/src/db/auth-schema.ts`: the hand-owned Drizzle schema mirroring `@better-auth/cli generate`. `user` has `id, name, email (unique), emailVerified, image, createdAt, updatedAt` — **no `role`/`banned` columns**. `session` has no `impersonatedBy`. Documents the regenerate workflow (temporarily add `@better-auth/cli`, generate, reconcile, remove, `db:generate`) and the **telemetry isolation contract** (no FK/join/shared id crosses account ↔ `marketplaceInstallEvents`).
- `apps/site/src/db/instance-schema.ts`: `instance` registry, `userId` FK → `user` `onDelete: cascade`. Confirms cascade erasure of instances.
- `apps/site/src/lib/instance-service.ts`: all instance logic goes through Better Auth's adapter (`auth.$context.adapter`) + typed API — the pattern any new admin/account service must follow (never raw SQL). `handleHeartbeat` returns 401 when the row is missing/revoked → the unlink signal.
- `contributing/authentication.md`: the two-identity model (local SQLite vs cloud Postgres, orthogonal, never migrated). Cloud auth section documents `createAuth`, device-link, revocation-to-401, telemetry isolation. This guide must gain a "Cloud account management (P3)" section.
- `apps/site/drizzle/`: committed SQL migrations `0000`–`0003`. A new migration adds the admin columns; generated via `db:generate` after the schema edit.
- `specs/accounts-and-auth/` (#268, implemented): the foundation this builds on — 02-specification.md is the design-doc style template; its telemetry-isolation and mailer-seam patterns carry forward.
- `research/20260702_auth_providers_oss_vs_managed.md`: Better-Auth-now / WorkOS-for-enterprise-later thesis. Confirms building on Better Auth's first-party admin plugin is the OSS path; managed console is the escape hatch if admin burden grows.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/site/src/lib/auth.ts` — register `admin()`, configure `account.accountLinking` + `user.deleteUser`; add the audit hook seam.
  - `apps/site/src/db/auth-schema.ts` — add admin columns to `user` (+ `impersonatedBy` to `session`); new `audit_log` table (likely a new `apps/site/src/db/audit-schema.ts` to keep files focused).
  - `apps/site/drizzle/` — one new generated migration.
  - `apps/site/src/lib/auth-client.ts` — add `adminClient()` to the client instance.
  - `apps/site/src/app/(account)/account/` — self-serve "Delete my account" + "Export my data" surfaces; an account-management feature slice under `apps/site/src/layers/features/account/`.
  - A new `apps/site/src/lib/account-service.ts` (self-serve export/delete server logic) + `apps/site/src/lib/audit-service.ts` (append audit rows), mirroring `instance-service.ts`'s adapter-only discipline.
- **Shared dependencies:** the Better Auth singleton (`getAuth()`), the Drizzle adapter seam (`auth.$context.adapter`), the mailer seam (`apps/site/src/lib/mailer.ts`) for any deletion/erasure confirmation email, `env.ts` for any new config, the FSD feature-slice layout already used by `features/account` + `features/instances`.
- **Data flow:** admin action (client `authClient.admin.*` or the future `/admin` UI) → Better Auth `/api/auth/admin/*` route → plugin mutates `user`/`session` through the adapter → an audit hook appends an `audit_log` row. Self-serve: `/account` action → `account-service` (export = read the user's own rows via adapter; delete = Better Auth `deleteUser` → cascade) → confirmation email via mailer.
- **Feature flags/config:** admin authorization is gated by `role: 'admin'` on the cloud `user` (plus an env-seeded admin-user-id allowlist for the break-glass founder-promote). No runtime feature flag is required, but the **timing gate** means the plugin ships behind a deliberate human EXECUTE decision.
- **Potential blast radius:**
  - Schema migration on the live Neon `user`/`session` tables — additive columns, but touches the auth hot path; **branch the Neon DB before applying** (issue edge case).
  - The telemetry-isolation test (`apps/site/src/db/__tests__/schema.test.ts`) enumerates the allowed account-cluster tables — a new `audit_log` table must be reconciled with that allowlist without crossing the telemetry boundary.
  - `accountLinking` changes how a Google login with an existing email resolves — a behavior change for the (currently ~0) live users; safe to set now precisely because volume is zero.
  - Impersonation issues a real session as another user — a footgun; must be audited and constrained.

## 4) Root Cause Analysis

Not a bug fix — omitted.

## 5) Research

**Solution space for each of the four scope items:**

1. **Admin capability — build vs adopt.**
   - **(a) Better Auth first-party `admin` plugin (recommended).** Ships ban/unban, impersonate, list/search/paginate, set-role, set-password, revoke-session(s), create/remove-user through one typed API with a role/permission model. Consistent with Better-Auth-as-source-of-truth; no bespoke identity mutation. Adds a small fixed set of columns.
   - (b) Hand-rolled admin queries over the adapter. More control, but re-implements auth-sensitive operations (ban semantics, session revocation, password reset) that the plugin already gets right, and diverges from the "everything through Better Auth" invariant. Rejected.
   - (c) Managed console (WorkOS/Clerk). The buy-not-build escape hatch; disproportionate now, revisit if admin burden grows (per the research report). Rejected for MVP.

2. **Admin console surface — now vs later.** The issue itself sequences a tailored `/admin` console as item 4 ("later/separate"). Recommendation: **enable the plugin now**, expose only what's needed to operate (the plugin's API + a thin, guarded internal page or scripted access), and design the full `/admin` console as a documented follow-up. Over-building UI before real users contradicts the timing gate.

3. **Self-serve delete + export.**
   - **Delete:** Better Auth's `user.deleteUser` (config-enabled, with optional verification callback + `beforeDelete`/`afterDelete` hooks) → the existing `onDelete: cascade` erases sessions/accounts/apikeys/instances. Prefer this typed path over a raw delete so hooks (audit + any final email) fire.
   - **Export:** assemble the user's own rows (profile, linked social accounts sans secrets, API-key/instance metadata sans secrets, audit entries about them) into a downloadable JSON — a read-only `account-service` function, secrets never included.
   - This is both a legal duty (GDPR Art. 17 erasure / Art. 20 portability; CCPA delete/know) and good product hygiene.

4. **Audit logging.**
   - A new append-only `audit_log` table (actor, action, target user, reason, metadata, timestamp) written from the admin plugin's action seam (hook/middleware) and from self-serve delete. Append-only, no PII beyond what identity management inherently needs, hard-isolated from telemetry. **Add it with adoption, not after an incident.**

**Cross-cutting edge cases to design in (from the issue):**

- Hashed secrets → management through Better Auth, never SQL.
- Prefer **ban (reversible)** over **hard-delete (irreversible, cascades instances)**; reserve delete for GDPR erasure.
- **Branch the Neon DB before bulk destructive ops.**
- **accountLinking policy**: email signup + later Google (same email) → decide link-vs-duplicate _before_ volume.
- Cleanup jobs: never-verified `user`+`verification` rows, expired `device_code`, stale `instance` via `lastSeenAt`.
- Impersonation is a footgun → audit every use.

**Recommendation:** Adopt the Better Auth `admin` plugin; ship self-serve delete/export and audit logging alongside it; defer the tailored `/admin` console to a follow-up. Sequence behind the human EXECUTE/timing gate.

## 6) Decisions

Resolved during ideation from the issue body + codebase constraints. A few genuinely open product decisions are surfaced for the operator (see below the table).

| #   | Decision                   | Choice                                                                                                                       | Rationale                                                                                                           |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Admin capability mechanism | Better Auth first-party `admin` plugin                                                                                       | Keeps Better Auth the single source of truth; ships ban/impersonate/revoke/list correctly; minimal, additive schema |
| 2   | Console scope for MVP      | Enable plugin + minimal guarded reach; **defer** the tailored `/admin` console to a follow-up                                | Timing gate + YAGNI; the issue itself sequences the console as "later/separate"                                     |
| 3   | Delete mechanism           | Better Auth `user.deleteUser` (typed) → existing `onDelete: cascade`                                                         | Hooks fire (audit + email); no bespoke cascade; secrets never touched                                               |
| 4   | Destructive-op default     | **Ban is the default lever** (reversible); hard-delete reserved for GDPR erasure + self-serve delete                         | Reversibility; hard-delete cascades instances irreversibly                                                          |
| 5   | Audit logging              | New append-only `audit_log` table, written from the admin action seam + self-serve delete, telemetry-isolated                | Compliance + forensics; add with adoption, not post-incident                                                        |
| 6   | Founder → admin promotion  | One-time break-glass: env-seeded `adminUserIds` allowlist (+ a documented one-time `role='admin'` promote)                   | No chicken-and-egg (no admin exists to promote the first admin); auditable and explicit                             |
| 7   | Schema ownership           | Extend the hand-owned `auth-schema.ts` (admin columns) + a new `audit-schema.ts`; regenerate the migration via `db:generate` | Matches the documented regenerate workflow; keeps the telemetry-isolation contract intact                           |
| 8   | Timing / dispatch          | Spec now; **withhold `agent/ready`**; EXECUTE is a human gate tied to registration opening                                   | The issue's explicit YAGNI-until-users constraint                                                                   |

**Open decisions to confirm with the operator during SPECIFY** (product/policy calls, not code):

- **D-A — accountLinking policy.** Should an email/password account and a later Google sign-in with the _same verified email_ auto-link into one user (Better Auth `account.accountLinking.enabled: true` with `trustedProviders`), or stay separate? Auto-linking avoids the "my instances vanished" duplicate; it carries a small account-takeover consideration (mitigated by requiring verified emails, which we already do). **Leaning: enable linking for verified-email providers.**
- **D-B — self-serve delete: hard-delete vs soft-deactivate.** GDPR erasure implies a genuine hard delete (cascade). Do we also offer a reversible "deactivate" for support-driven cases, or is self-serve strictly hard-delete + admin ban covering the reversible case? **Leaning: self-serve = hard-delete (erasure); reversible cases handled by admin ban.**
- **D-C — cleanup jobs now or later.** Scheduled cleanup (unverified signups, expired device codes, stale instances) — include in this spec's phases or split to a follow-up issue? **Leaning: design here, split execution to a follow-up (no scheduler exists in `apps/site` yet).**

## 7) Recommended Next Step

**Move to SPECIFY.** The intent, options, and most decisions are resolved; three product decisions (D-A/B/C) are bounded and will be confirmed at the top of SPECIFY. The specification will pin exact Better Auth `admin` plugin identifiers (option names, added columns, API methods), the audit-log schema, the self-serve export/delete design, the migration + Neon-branch procedure, and the phase split (MVP: plugin + delete/export + audit; follow-ups: `/admin` console, cleanup jobs). Seed draft ADRs for (1) adopting the admin plugin + audit-log model and (2) the accountLinking policy.
