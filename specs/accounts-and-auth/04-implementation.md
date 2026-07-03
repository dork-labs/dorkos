---
slug: accounts-and-auth
number: 268
created: 2026-07-02
status: in-progress
last_updated: 2026-07-02
---

# Accounts & Auth: Implementation Log

**Status:** In Progress
**Spec:** `specs/accounts-and-auth/02-specification.md`
**Tasks:** 14 (8 P1 + 6 P2)

## Session

- **Worktree:** `/Users/doriancollier/.dork/workspaces/dorkos/spec-accounts-and-auth`
- **Branch:** `spec-accounts-and-auth` (based on `main@4f424328`, the SPECIFY+DECOMPOSE intent commit)
- **Ports:** DORKOS_PORT=4310, VITE_PORT=4460, SITE_PORT=4610
- **Execution model:** tasks implemented sequentially by background agents (one shared worktree cannot host concurrent `pnpm install`/turbo state safely); commits and code-review gates grouped by dependency batch. Each batch is one commit, reviewed by a REVIEW.md-guided code-reviewer subagent, with all findings addressed before the next batch.

## Batch plan (dependency waves)

- **Batch 1:** 1.1 (server Better Auth core) -> 2.1 (site Better Auth core). Both add deps; sequential.
- **Batch 2:** 1.2 (session-gate), 1.3 (exposure-guard), 1.7 (CLI auth), 2.2 (account UI).
- **Batch 3:** 1.4 (MCP per-user keys), 1.5 (client auth feature), 2.3 (device-link rail, DOR-182).
- **Batch 4:** 1.6 (remove passcode/cookie-session), 2.4 (local cloud-link + CLI).
- **Batch 5:** 1.8 (verify P1 + docs), 2.5 (client linking panel).
- **Batch 6:** 2.6 (verify P2 + docs).

## Progress

**Tasks Completed: 2 / 14**

### Session 1 - 2026-07-02

**Batch 1 (commit pending review):**

- Task 1.1: Embed Better Auth in apps/server (SQLite schema, owner-only registration, `auth.enabled` config + migration `0.47.0`). Server suite green (3146 tests).
- Task 2.1: Stand up Better Auth on apps/site (Neon pg, Resend mailer seam, GitHub+Google social, telemetry-isolation test). Site suite green (97 tests), `next build` clean.

## Files Modified/Created

- Server auth core: `apps/server/src/services/core/auth/` (index + tests), `apps/server/src/lib/trusted-origins.ts`, `apps/server/src/app.ts`, `apps/server/src/index.ts`, `apps/server/src/routes/config.ts`
- Config: `packages/shared/src/config-schema.ts`, `apps/server/src/services/core/config-manager.ts` (+ tests), `contributing/configuration.md`, `docs/getting-started/configuration.mdx`
- DB schema: `packages/db/src/schema/auth.ts` (+ index, drizzle.config, migration `0019`)
- Site auth core: `apps/site/src/lib/auth.ts`, `apps/site/src/lib/mailer.ts`, `apps/site/src/db/auth-schema.ts` (+ schema re-export + isolation test), `apps/site/src/app/api/auth/[...all]/route.ts`, `apps/site/src/env.ts`, `apps/site/.env.example`, site drizzle migration `0002`
- Lockfile: `pnpm-lock.yaml` (better-auth, @better-auth/api-key, resend)

## Known Issues

- **`extension-routes` proxy test** is flaky in the full server run (times out under load; passes 7/7 in isolation). Pre-existing, unrelated to auth. See `[[project_express5_proxy_test_preexisting_fail]]`.
- **Site drizzle meta drift repaired** in task 2.1: the pre-existing hand-written `0001_add_source_type.sql` lacked a snapshot/journal entry; 2.1 added `0001_snapshot.json` + journal entries so `db:generate` emitted a clean auth-only `0002`. Touched migration metadata only, never the telemetry table. Flag for review.
- **`@better-auth/cli` intentionally not a dependency** anywhere (it forks the drizzle-orm peer hash). Auth schemas were generated once then hand-owned; regeneration workflow documented in each schema file header.
- **`BETTER_AUTH_SECRET`** must be set in production for both instances (server + site); documented in config docs + `.env.example`.
