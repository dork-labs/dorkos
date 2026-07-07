---
slug: cloud-account-management
number: 260706-234037
created: 2026-07-06
status: implemented
---

# Cloud Account Management — Implementation Notes

**Tracker:** DOR-187 · **Spec:** `02-specification.md` · **Built:** 2026-07-06

Phase 1 (MVP) is implemented in `apps/site`. All work is behind the human EXECUTE
gate that the spec calls out; the tailored `/admin` console and scheduled cleanup
jobs remain follow-ups (not built here).

## What shipped

| Task | Result                                                                                                                                                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | Admin columns (`role`/`banned`/`banReason`/`banExpires` on `user`, `impersonatedBy` on `session`) + append-only `audit_log` (`db/audit-schema.ts`, no FK to `user`). Migration `drizzle/0004_great_scarlet_spider.sql` (additive; `role` backfills via default). Isolation test extended (21 tests). |
| 1.2  | `auth.ts`: `admin()` + `auditRegistry()` plugins, `account.accountLinking` (D-A), `user.deleteUser` (D-B) with audit hooks, admin-action audit via `hooks.after`.                                                                                                                                    |
| 1.3  | `audit-service.ts` — `recordAudit` / `listAudit` over the adapter.                                                                                                                                                                                                                                   |
| 1.4  | `account-service.ts` + `GET /api/account/export` — GDPR export, secrets stripped.                                                                                                                                                                                                                    |
| 1.5  | Ban disables the target's API keys (`admin-audit-hook.ts`), closing the ban→heartbeat gap.                                                                                                                                                                                                           |
| 1.6  | `adminClient()` + `/account` `DangerZone` (export + delete with typed confirmation + email step).                                                                                                                                                                                                    |
| 1.7  | `ADMIN_USER_IDS` env break-glass; founder-promote documented.                                                                                                                                                                                                                                        |
| 1.8  | Integration tests over the in-memory adapter (config wiring, audit round-trip, export secret-stripping, admin ban → audit + key-disable). 27 tests green across schema + account-management.                                                                                                         |
| 1.9  | `contributing/authentication.md` + `configuration.md` updated; ADRs `260707-010337` (admin plugin + audit log) and `260707-010338` (accountLinking policy).                                                                                                                                          |

## Deviations & decisions confirmed at build time

- **Audit model id** is a random `uuid` (not `bigserial`) so audit rows are
  written through the Better Auth adapter (`auditRegistry()` plugin), keeping the
  same code path in production and the in-memory tests — mirroring the `instance`
  registry.
- **`ctx.context.session` in the after-hook** reliably yields the acting admin's
  id (validated by the ban integration test), so admin actions are attributed
  correctly.
- **Ban disables (not deletes) API keys** — reversible and sufficient, since
  `verifyApiKey` rejects disabled keys (heartbeat 401).
- **Cascade erasure** is a Postgres FK behavior the in-memory adapter cannot
  exercise, so it is guarded at the schema level (a test asserts every
  user-referencing FK is `onDelete: cascade`).
- **Verify-at-implementation items resolved:** `defaultBanExpiresIn` was omitted
  (not a confirmed 1.6.23 option); generated snake_case columns match the schema
  (`ban_reason`/`ban_expires`/`impersonated_by`); `accountLinking` and
  `deleteUser` option names confirmed against the running instance via tests.

## Not built (follow-ups)

- Tailored `/admin` console (users + instances + keys) over the plugin.
- Scheduled cleanup jobs (unverified signups, expired device codes, stale
  instances) — needs a Vercel-cron vehicle in `apps/site`.
