---
slug: cloud-account-management
number: 260706-234037
created: 2026-07-06
status: specified
---

# Cloud Account Management: Better Auth Admin Plugin + Self-Serve Delete/Export

**Status:** Draft <!-- Draft | Under Review | Approved | Implemented -->
**Author:** Dorian (via /flow)
**Date:** 2026-07-06
**Tracker:** DOR-187
**Verified against:** `better-auth@1.6.23`, `@better-auth/api-key@1.6.23` (pnpm-lock.yaml)

## Overview

Add account management to the **cloud** DorkOS identity core (`apps/site`, dorkos.ai, Neon Postgres) that shipped open self-registration in spec #268 (accounts-and-auth, PR #76). Three shipped capabilities plus one designed follow-up:

1. **Better Auth `admin` plugin** — ban/unban, impersonate, revoke sessions, set password, list/search, create/remove user, set-role — all through Better Auth's typed API.
2. **Self-serve "Delete my account" + data export** at `/account` — GDPR Art. 17 erasure + Art. 20 portability / CCPA.
3. **Audit logging** — an append-only record of admin actions and impersonation (who / what / when / why).
4. **Follow-up (designed here, executed separately):** a tailored `/admin` console and scheduled cleanup jobs.

This spec covers the **cloud** instance only. The **local** self-hosted server (`apps/server`, SQLite, owner-only single-user via `dorkos auth`) is out of scope.

## Background / Problem Statement

`apps/site/src/lib/auth.ts` runs a Better Auth instance with open self-registration (email/password + required verification, GitHub/Google) over Neon Postgres. There is **no admin surface** and **no self-serve account lifecycle**. Once strangers create accounts, we owe them and ourselves: support operations (resend verification, lockout, email change, duplicate resolution), abuse/security response (disable, revoke sessions + API keys), **GDPR/CCPA erasure + export (a legal duty)**, and ops/debugging (inspect linked instances + keys).

The schema already supports clean deletion: `session`, `account`, `apikey`, and `instance` all reference `user.id` with `onDelete: cascade`, so removing one `user` row atomically erases sessions, OAuth links, API keys, and linked instances. A deleted user's instances lose their link on the next heartbeat (missing row → 401 → unlink, per `handleHeartbeat` in `instance-service.ts`).

**Timing gate (load-bearing).** The originating issue (DOR-187) mandates implementation _when cloud self-registration opens to real users_, not before (currently ~0 users; YAGNI). This spec is authored now so the design is ready. The EXECUTE decision is a **human gate**; `agent/ready` was deliberately withheld at TRIAGE so nothing auto-dispatches this.

## Goals

- Enable the Better Auth `admin` plugin with a minimal, correct role model and a break-glass path to promote the first admin.
- Ship self-serve **hard delete** (GDPR erasure) and **data export** at `/account`.
- Record every admin action and impersonation in an append-only, telemetry-isolated `audit_log`.
- Set `account.accountLinking` so a verified-email Google/GitHub login links to an existing email/password account rather than duplicating it.
- Keep every mutation on Better Auth's typed API (never raw SQL); preserve the account ↔ telemetry isolation contract.
- Provide a safe migration procedure (Neon branch before applying) for the additive schema change.

## Non-Goals

- The tailored `/admin` console UI (scope item 4) — **designed** in "Implementation Phases → Follow-ups", not built in the MVP.
- Scheduled cleanup jobs (unverified signups, expired device codes, stale instances) — **designed** here, execution split to a follow-up (no scheduler exists in `apps/site`).
- The local `apps/server` SQLite auth instance and `dorkos auth` CLI.
- Identity migration between local and cloud instances (never happens by design).
- Billing/subscription state (no such tables exist).
- Buying a managed admin (WorkOS/Clerk) — the buy-not-build lever in `research/20260702_auth_providers_oss_vs_managed.md`, not this path.

## Resolved Product Decisions

Confirmed with the operator at the top of SPECIFY:

| #   | Decision                    | Choice                                                                                                                                                     | Consequence                                                                                                                                           |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-A | accountLinking policy       | **Auto-link verified providers** — `accountLinking.enabled: true`, `trustedProviders: ['google','github','email-password']`, `allowDifferentEmails: false` | A later Google/GitHub sign-in with the same verified email links to the existing user; no duplicate. Safe because verified email is already required. |
| D-B | Self-serve delete semantics | **Hard delete (GDPR erasure)** via Better Auth `deleteUser` → `onDelete: cascade`                                                                          | Reversible support cases are handled by admin **ban**, not soft-deactivation.                                                                         |
| D-C | Cleanup jobs scope          | **Design here, execute in a follow-up**                                                                                                                    | The cleanup design is specified; a separate issue stands up the Vercel-cron vehicle and implements it.                                                |

## Technical Dependencies

- `better-auth@1.6.23` — the `admin` plugin (`better-auth/plugins`), the `adminClient()` (`better-auth/client/plugins`), and core `user.deleteUser` + `account.accountLinking` config. Already a dependency.
- `@better-auth/api-key@1.6.23`, `deviceAuthorization` — existing plugins; the admin plugin adds only `user`/`session` columns and collides with neither (they own separate tables). All plugins must be registered at `@better-auth/cli generate` time so one migration covers everything.
- `drizzle-orm@0.45.2` + `drizzle-kit@0.31.10`, `@neondatabase/serverless@1.1.0` — existing; `db:generate` produces the migration.
- Resend via the existing mailer seam (`apps/site/src/lib/mailer.ts`) — for the delete-account verification email.
- Docs: Better Auth v1.6.23 `plugins/admin.mdx`, `concepts/users-accounts.mdx`.

## Detailed Design

### 1. Admin plugin registration (`apps/site/src/lib/auth.ts`)

Add to the `plugins: [...]` array in `createAuth`:

```ts
import { admin } from 'better-auth/plugins';

admin({
  adminRoles: ['admin'], // default; explicit for clarity
  adminUserIds: env.ADMIN_USER_IDS, // break-glass allowlist (see §5); string[]
  impersonationSessionDuration: 60 * 60, // 1h (default); explicit
  defaultBanReason: 'Violated the DorkOS terms of service',
});
```

- **Role model:** plain `role: 'admin'` grants all admin operations; `adminUserIds` bypasses role checks entirely. We do **not** need `createAccessControl` for the MVP — a single `admin` role is sufficient. (A custom access controller is a documented later option if granular roles emerge; noted in Follow-ups.)
- **`defaultRole`** stays `'user'` (the plugin default), so new self-registrations are non-admin.
- Register `admin()` alongside the existing `deviceAuthorization`, `apiKey`, and `instanceRegistry` plugins so `@better-auth/cli generate` emits one complete migration.

> **Verify-at-implementation (researcher flagged):** confirm whether `defaultBanExpiresIn` exists as an admin option in 1.6.23 before naming it — only the per-call `banExpiresIn` param is confirmed. Do not add it speculatively.

### 2. Self-serve delete + accountLinking config (`apps/site/src/lib/auth.ts`)

Add to the `betterAuth({...})` options:

```ts
account: {
  accountLinking: {
    enabled: true,
    trustedProviders: ['google', 'github', 'email-password'],
    allowDifferentEmails: false,
  },
},
user: {
  deleteUser: {
    enabled: true,
    sendDeleteAccountVerification: async ({ user, url }) => {
      await sendDeleteAccountVerification({ to: user.email, url }); // new mailer fn
    },
    beforeDelete: async (user) => {
      await recordAudit({ actorUserId: user.id, action: 'account.self_delete.requested', targetUserId: user.id });
    },
    afterDelete: async (user) => {
      await recordAudit({ actorUserId: user.id, action: 'account.self_delete.completed', targetUserId: user.id });
    },
  },
},
```

- Self-serve deletion requires the emailed token before the record is removed (`sendDeleteAccountVerification` set → `authClient.deleteUser({...})` triggers the email; the record is erased only after the callback). This prevents a hijacked session from silently erasing an account.
- The `onDelete: cascade` chain then erases `session`/`account`/`apikey`/`instance`. Linked instances 401 on next heartbeat and self-unlink.

> **Verify-at-implementation:** the exact `deleteUser` verification redirect option identifier (a `deleteUserCallbackURL`-style field) and the literal `account.accountLinking.enabled` / `allowDifferentEmails` names against the 1.6.23 type files before finalizing. `trustedProviders` and `sendDeleteAccountVerification` are source-confirmed.

### 3. Schema changes

**`apps/site/src/db/auth-schema.ts`** — add the admin columns (hand-owned file; keep the isolation contract + regenerate workflow intact):

- `user`: `role` (text, default `'user'`), `banned` (boolean, nullable), `banReason` (text, nullable), `banExpires` (timestamp, nullable).
- `session`: `impersonatedBy` (text, nullable) — the impersonating admin's `user.id`.

> **Verify-at-implementation:** the snake_case DB column names (`ban_reason`/`ban_expires`/`impersonated_by`) are the adapter's casing output — do not assert them by hand. Regenerate per the documented workflow (temporarily add `@better-auth/cli`, `better-auth generate` against `src/lib/auth.ts`, reconcile into `auth-schema.ts`, remove the CLI dep) and read the emitted names.

**`apps/site/src/db/audit-schema.ts`** (new) — append-only audit log:

```ts
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    actorUserId: text('actor_user_id').notNull(), // who performed it (admin, or the user for self-serve)
    action: text('action').notNull(), // e.g. 'admin.ban_user', 'admin.impersonate', 'account.self_delete.completed'
    targetUserId: text('target_user_id'), // the affected account (nullable for non-user-scoped actions)
    reason: text('reason'), // ban reason / free-text justification
    metadata: text('metadata'), // JSON string: extra context (never a secret)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_audit_log_target_created').on(t.targetUserId, t.createdAt.desc())]
);
```

- **No FK** from `audit_log` to `user`: a hard-deleted user must not cascade-erase the audit trail of actions taken against them (the audit record must outlive the account, storing the id as a plain string). This is deliberate and documented in the file's TSDoc.
- **Telemetry isolation:** `audit_log` sits in the account cluster but must add **no** FK/join/shared identifier to `marketplaceInstallEvents`. `apps/site/src/db/__tests__/schema.test.ts` enumerates allowed account-cluster tables and asserts zero telemetry crossings — add `audit_log` to that allowlist and extend the assertions to cover it. (It references only `user` ids as opaque strings, never telemetry.)

**Migration:** after the schema edits, run `pnpm --filter @dorkos/site db:generate` to emit one new `drizzle/000N_*.sql`. **Before applying to production Neon, create a Neon branch** (the issue's explicit safeguard) so the additive `ALTER TABLE`s are validated on a copy first.

### 4. Server services (adapter-only, mirroring `instance-service.ts`)

- **`apps/site/src/lib/audit-service.ts`** (new) — `recordAudit(entry)` appends one `audit_log` row through `auth.$context.adapter` (or the Drizzle client). Never logs a secret. A thin `listAudit({ targetUserId?, limit, offset })` read for the export + future console.
- **`apps/site/src/lib/account-service.ts`** (new) — `exportAccountData(auth, userId)`: assembles the signed-in user's own rows into a portability JSON — profile (`user`), linked providers (`account` rows with **tokens/passwords stripped**), API-key + instance metadata (**key values stripped**), and audit entries about them. Read-only; secrets never included.
- **Admin action audit seam:** wrap the admin plugin's mutating operations so each writes an `audit_log` row. Prefer a Better Auth `hooks.after` middleware keyed on the `/admin/*` paths (the same pattern the existing `/device/token` after-hook uses in `auth.ts`), capturing `actorUserId` (the admin session user), `action` (from the path), `targetUserId` (from the request body `userId`), and `reason`. Impersonation (`/admin/impersonate-user`) is audited explicitly — it is the highest-risk action.

### 5. Break-glass: promoting the first admin

No admin exists to promote the first admin (chicken-and-egg). Two complementary mechanisms:

- **`adminUserIds` env allowlist** (`ADMIN_USER_IDS`, comma-separated, parsed in `env.ts`): listed user ids get full admin regardless of `role`. This is the zero-state bootstrap — set the founder's `user.id` here and they can operate immediately after the plugin ships.
- **One-time `role='admin'` promotion:** documented break-glass `UPDATE user SET role='admin' WHERE id=...` via the Neon SQL editor (per the issue's "promote-founder-to-admin step"), for durability beyond the env var. This is the only sanctioned raw-SQL touch, and it is documented, not routine.

### 6. Client wiring

- **`apps/site/src/lib/auth-client.ts`** — add `adminClient()` from `better-auth/client/plugins` to the client `plugins: [...]`.
- **`/account` UI** (`apps/site/src/app/(account)/account/...` + a `features/account` slice): a "Danger zone" card with **Export my data** (downloads the portability JSON) and **Delete my account** (double-confirm → `authClient.deleteUser()` → "check your email" → erasure on callback). Copy is plain and honest; no dark patterns (deletion is as easy as the docs allow).

### API changes

All admin endpoints are provided by the plugin under `/api/auth/admin/*` (server `auth.api.*`, client `authClient.admin.*`): `createUser`, `listUsers` (search/paginate), `setRole`, `banUser` (`{ userId, banReason?, banExpiresIn? }` — seconds; **revokes all sessions**), `unbanUser`, `listUserSessions`, `revokeUserSession`, `revokeUserSessions`, `impersonateUser` (→ `{ sessionToken }`, capped at `impersonationSessionDuration`), `stopImpersonating`, `removeUser` (hard delete), `setUserPassword`. Self-serve delete is `authClient.deleteUser()` (core, not admin). One new site route (or server action) serves the export JSON. No changes to existing device-link / heartbeat / instance routes.

### Data model changes

Additive only: 4 columns on `user`, 1 on `session`, 1 new `audit_log` table. No column drops, no changes to `marketplaceInstallEvents`, no changes to `instance`/`apikey`/`deviceCode` shapes.

## User Experience

- **End user (`/account`):** sees linked providers and instances (existing), plus a Danger Zone: _Export my data_ (immediate download) and _Delete my account_ (confirm → email verification → irreversible erasure; a linked instance goes offline on its next heartbeat). A prior email/password user who later "Sign in with Google" on the same verified email lands in the **same** account (no duplicate) — D-A.
- **Admin (MVP):** operates via `authClient.admin.*` (a thin guarded internal page or scripted access is acceptable for the MVP; the full console is a follow-up). Ban is the default lever for abuse (reversible, kills sessions); hard `removeUser` is reserved for erasure requests.
- **Error/exit paths:** delete without email confirmation → no erasure. Non-admin hitting an admin op → Better Auth `FORBIDDEN`. Banned user sign-in → `bannedUserMessage`.

## Testing Strategy

Follow the existing `apps/site` pattern: `createAuth` over an **in-memory adapter** with the mailer mocked — no Postgres, no network (as `auth.integration.test.ts` / `instance-flow.integration.test.ts` already do).

- **Unit:** `audit-service` (records the right action/actor/target; never persists a secret); `account-service.exportAccountData` (includes the user's own rows; **excludes** password hashes, OAuth tokens, API-key values); `env.ts` parse of `ADMIN_USER_IDS`.
- **Integration (in-memory adapter):**
  - admin: promote via `adminUserIds`, `banUser` blocks sign-in + revokes sessions, `unbanUser` restores, `impersonateUser` mints a capped session and writes `session.impersonatedBy` + an audit row, `setRole`/`setUserPassword`/`removeUser` behave and audit.
  - self-serve: `deleteUser` requires the email token, then cascade-erases `session`/`account`/`apikey`/`instance` (assert all gone); `afterDelete` audit row survives the user (no FK cascade on `audit_log`).
  - accountLinking (D-A): email/password user + Google sign-in with the same verified email → one `user`, two `account` rows.
- **Schema isolation:** extend `apps/site/src/db/__tests__/schema.test.ts` so the new `audit_log` table is in the allowed account-cluster set and asserted to have **no** telemetry FK/join/shared id.
- **Edge cases that can fail:** ban does **not** revoke a banned user's active **API keys** (only sessions) — assert the current behavior and decide in Security whether to also revoke keys on ban; impersonation session must expire at `impersonationSessionDuration`; export must omit secrets even as fields are added later.

Each test carries a purpose comment; no always-pass tests.

## Performance Considerations

Negligible. Additive nullable columns and one indexed append-only table. Admin list/search paginates via the plugin. Audit writes are single-row inserts off the hot auth path. Export is a bounded per-user read. No impact on the device-link/heartbeat hot path.

## Security Considerations

- **Impersonation is a footgun** — it mints a real session as another user. It is capped (`impersonationSessionDuration`, 1h) and **every use is audited** (`session.impersonatedBy` + an `audit_log` row). The future `/admin` console must surface an active-impersonation banner.
- **Ban revokes sessions, not API keys** (researcher-verified). A banned user's active instance API keys keep authenticating heartbeats. **Decision for implementation:** on `banUser`, also disable/delete the user's `apikey` rows (a ban hook), so a banned account cannot keep a linked instance alive. Assert this in tests.
- **Hard delete cascades irreversibly** (instances included). Prefer **ban** for reversible cases; reserve `removeUser`/self-serve delete for genuine erasure. **Branch the Neon DB before bulk destructive ops.**
- **Hashed secrets** (passwords, API keys) are never readable/settable via SQL — all management is through Better Auth. Raw SQL is break-glass only (the one-time founder promote).
- **Break-glass surface:** `ADMIN_USER_IDS` is an env secret; the one-time promote is documented and auditable. Admin endpoints are gated by role/allowlist server-side.
- **Audit integrity:** `audit_log` is append-only and outlives deleted users (no FK cascade), so an erasure cannot destroy the record that it happened.
- **Telemetry isolation preserved:** `audit_log` adds no crossing to `marketplaceInstallEvents`; the no-PII install-telemetry contract is untouched.
- **accountLinking (D-A):** auto-link is restricted to `trustedProviders` with `allowDifferentEmails: false`, and we already require verified emails — closing the classic auto-link account-takeover vector.

## Documentation

- Extend `contributing/authentication.md` with a "Cloud account management (P3)" section: the admin plugin + role model + break-glass promote, self-serve delete/export, the audit-log model, and the accountLinking policy. Update the "Key Files" table (add `admin` plugin, `audit-schema.ts`, `audit-service.ts`, `account-service.ts`).
- Update `contributing/configuration.md` / env reference for `ADMIN_USER_IDS` and any new mailer env.
- A runbook note: the Neon-branch-before-destructive-ops procedure and the founder-promote break-glass step.
- Seed draft ADRs (see Related ADRs).

## Implementation Phases

- **Phase 1 — MVP (this spec's EXECUTE, behind the timing gate):**
  1. Schema: admin columns on `user`/`session` + `audit-schema.ts`; regenerate + one migration; extend the isolation test.
  2. `auth.ts`: register `admin()`, add `accountLinking` (D-A) + `user.deleteUser` (D-B) config + the admin audit hook.
  3. `audit-service.ts` + `account-service.ts` (export); ban-hook to also revoke API keys.
  4. Client: `adminClient()`; `/account` Danger Zone (export + delete).
  5. Break-glass: `ADMIN_USER_IDS` env + documented founder promote.
  6. Tests (unit + in-memory integration + isolation); docs (`authentication.md`).
- **Follow-ups (designed here, separate issues — NOT this spec's EXECUTE):**
  - **`/admin` console** (scope item 4): a guarded `/admin` route over the plugin + `instance-service` (users + instances + keys); optional `createAccessControl` for granular roles; active-impersonation banner.
  - **Cleanup jobs** (D-C): a Vercel-cron vehicle purging never-verified `user`+`verification` rows, expired `device_code`, and stale `instance` rows by `lastSeenAt`. Requires standing up a scheduler in `apps/site`.

## Open Questions

- ~~accountLinking policy~~ **(RESOLVED, D-A)** — Answer: auto-link verified `trustedProviders`, `allowDifferentEmails: false`. Rationale: kills the duplicate-account problem; safe under required email verification.
- ~~Self-serve delete semantics~~ **(RESOLVED, D-B)** — Answer: hard delete (GDPR erasure); reversible cases via admin ban. Rationale: clean legal-duty story; ban covers recoverable moderation.
- ~~Cleanup jobs scope~~ **(RESOLVED, D-C)** — Answer: design here, execute in a follow-up. Rationale: no scheduler in `apps/site` yet.
- **Verify-at-implementation (researcher-flagged, low-risk):** the exact `defaultBanExpiresIn` admin option (may not exist in 1.6.23), the `deleteUser` verification-redirect option identifier, the literal `accountLinking.enabled`/`allowDifferentEmails` names, and the generated snake_case column names. Resolve each by reading the 1.6.23 type files / `generate` output during EXECUTE, not by guessing.
- **Should ban also revoke API keys?** Leaning **yes** (see Security) — pin during EXECUTE with a test.

## Related ADRs

Two draft ADRs to seed (see DECOMPOSE / `/adr:from-spec`):

- **ADR — Adopt Better Auth's first-party `admin` plugin + an append-only audit log for cloud account management** (vs hand-rolled admin queries or a managed console). Captures: Better-Auth-as-source-of-truth, ban-over-delete default, audit-log-outlives-user (no FK), telemetry isolation preserved.
- **ADR — Cloud accountLinking policy: auto-link verified trusted providers** (D-A). Captures the account-takeover reasoning and the `allowDifferentEmails: false` + verified-email constraint.

## References

- Tracker: DOR-187 (Cloud account management).
- Foundation: spec #268 `specs/accounts-and-auth/`, PR #76 (`7f4d82e0`).
- Code: `apps/site/src/lib/auth.ts`, `apps/site/src/db/auth-schema.ts`, `apps/site/src/db/instance-schema.ts`, `apps/site/src/lib/instance-service.ts`, `apps/site/src/db/__tests__/schema.test.ts`.
- Docs: `contributing/authentication.md`; Better Auth v1.6.23 `plugins/admin.mdx`, `concepts/users-accounts.mdx`.
- Buy-not-build lever: `research/20260702_auth_providers_oss_vs_managed.md`.
