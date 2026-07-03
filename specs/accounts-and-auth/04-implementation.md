---
slug: accounts-and-auth
number: 268
created: 2026-07-02
status: complete
last_updated: 2026-07-03
---

# Accounts & Auth: Implementation Log

**Status:** Complete
**Spec:** `specs/accounts-and-auth/02-specification.md`
**Tasks:** 14 / 14 (8 P1 + 6 P2)

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

**Tasks Completed: 14 / 14**

### Session 1 - 2026-07-02

**Batch 1 (committed `c300e150` + review-fix commit; reviewed: no blockers, 2 nits addressed — fail-closed prod `BETTER_AUTH_SECRET` in `getAuth()`, baseURL note):**

- Task 1.1: Embed Better Auth in apps/server (SQLite schema, owner-only registration, `auth.enabled` config + migration `0.48.0`). Server suite green (3146 tests).
- Task 2.1: Stand up Better Auth on apps/site (Neon pg, Resend mailer seam, GitHub+Google social, telemetry-isolation test). Site suite green (97 tests), `next build` clean.

**Batch 2 (committed `33ede6c6` + review-fix commit; reviewed: 2 CRITICAL security holes found + fixed — case-insensitive auth bypass in the session-gate, backslash open-redirect in `safeReturnTo`; + a CLI DORK_HOME nit):**

- Task 1.2: Session-gate middleware for `/api/*` + `/mcp` (cookie or API key), shared `verifyRequestAuth` helper reused by 1.4. 22 auth tests + SSE integration green.
- Task 1.3: Exposure-guard — tunnel-start 409 (`AUTH_REQUIRED_FOR_EXPOSURE`) + non-loopback bind hard-gate; pure injectable predicate, 22 unit tests. Added `DORKOS_ALLOW_INSECURE_BIND` escape hatch (default false) for the Docker `0.0.0.0` images.
- Task 1.7: `dorkos auth enable` / `reset-password` CLI. CLI-local `createOwnerAuth(db)` factory (spike-proven interoperable with the server's scrypt hashes); 310 CLI tests + built-binary e2e green.
- Task 2.2: dorkos.ai account UI — `/signin`, `/signup`, `/verify-email`, `/reset-password`(+confirm), `/account` (server session guard, `returnTo` open-redirect guard). One `@/lib/auth-client` wrapper. 35 new tests (137 site total), `next build` clean.
- Fix: `packages/db` `migrations.test.ts` expected-tables list updated for the 5 auth tables (a batch-1 regression 1.1 missed; db suite now 11/11).

**Batch 3 (commit pending review):**

- Task 1.4: MCP auth rewritten for per-user API keys (4-tier: env override → per-user key → legacy compat → localhost pass-through), idempotent legacy `mcp.apiKey` seeding (direct adapter insert with the plugin's `defaultKeyHasher`), removed the two old `/config/mcp/*` key endpoints, `authSource: 'env'|'user-keys'|'none'`. 104 tests green.
- Task 1.5: Client auth slice `features/auth/` (LoginScreen, OwnerSetupScreen, AuthGuard, API-keys UI), Security settings tab, `credentials: 'include'` across all transport fetch paths, exposure flow, AuthGuard wired into `main.tsx`. Removed the dead `generateMcpKey` transport method (zero dangling refs). Thin REST auth client (not `better-auth/client`, which would need an install). 4310 client tests green; shared/obsidian/server typecheck clean.
- Task 2.3 (DOR-182, xl): device-link rail — `deviceAuthorization` + `apiKey` plugins, `instance` table + migration `0003`, session→scoped-API-key swap via a `/device/token` after-hook, `POST /api/instances/heartbeat`, revocation (→401), `/activate` + `/account/instances` pages. Telemetry isolation extended. 161 site tests green, `next build` clean. Batch-3 review: no blockers, 4 nits fixed (heartbeat JSDoc, field clamp, session-leak regression assertions, pending GET→POST).

**Batch 4 (commit pending review):**

- Task 1.6: Removed the tunnel passcode system + cookie-session entirely (12 files deleted: `tunnel-auth.ts`, `passcode-hash.ts`, `tunnel-gate/`, `TunnelSecurity.tsx`, passcode routes/config/constants/`dorkos_session`; `cookie-session` dep gone). Config migration `0.49.0` cleans legacy keys. `PasscodeGateWrapper` → `AuthGuard` in `main.tsx`. Dangling-ref sweep clean. Server 538 + client 4293 tests green.
- Task 2.4: Local cloud-link — `cloud-link-client.ts` (pure RFC 8628 device-flow client) + `CloudLinkManager` (token lifecycle, 15-min heartbeat, 401→unlink), `/api/cloud/*` (start/status/unlink/status), `cloud` config section + migration `0.50.0`, `dorkos cloud login|logout|status` CLI. Independent of `auth.enabled`. 76 server + 8 CLI tests green. (Deviation: `logout` clears the local token but can't self-revoke server-side — cloud revoke is session-guarded; human revokes from `/account/instances`.) Batch-4 review: no blockers, 2 nits + 1 info fixed (account label now returned by heartbeat → `cloud.linkedAccountLabel`; CHANGELOG wording; regenerated openapi.json).

**Batch 5 (commit pending review):**

- Task 2.5: Client Settings > "DorkOS account" panel — `cloud-methods.ts` transport factory (4 methods on the `Transport` interface + DirectTransport stub + mock), `useCloudLink` polling hook, `CloudLinkPanel` (idle/pending/linked/expired/denied/revoked). `window.open` guarded to http(s). Visible regardless of local login. 8 new tests, 4301 client tests green; shared/client/obsidian typecheck clean.
- Task 1.8: P1 verification + docs. Repo-wide `pnpm typecheck|lint|build|test` ALL RAN + PASS (server 3198 tests fresh). Playwright auth-flow spec written + validated (gated behind `DORKOS_E2E_AUTH`, not run live to avoid mutating shared auth state). Electron + built-CLI smoke documented as MANUAL (need GUI). Created `contributing/authentication.md` + `docs/self-hosting/securing-your-instance.mdx`; updated tunnel/config/architecture guides + INDEX + docs-coverage-map; tidied CHANGELOG. Committed the generated `docs/api/api/cloud/*.mdx` reference pages. Batch-5 review: no blockers, 2 useCloudLink nits fixed (mount/poll race guards, unlink catch).

**Batch 6 (final gate — commit pending review):**

- Task 2.6: P2 verification + docs (FINAL). Repo-wide `pnpm typecheck|lint|build|test` (incl. Next.js site) ALL RAN + PASS — full suite ~11k tests green (server 3198, client 4301, site 161, + relay/cli/mesh/a2a/marketplace/skills/harness/db); no flake triggered. Security review PASS with file:line evidence (scoped instance tokens + server-side revocation + sensitive-config storage; telemetry no-PII isolation covering user/session/account/verification/apikey/deviceCode/instance; zero Anthropic-credential references). Two-service device-link E2E documented as manual (deferred per spec; integration tests cover it). Created `docs/self-hosting/dorkos-accounts.mdx`; expanded `contributing/authentication.md` cloud section; added site env vars to configuration.md + environment-variables.md; CHANGELOG + coverage map.

## Spec completion

All 14 tasks (8 P1 + 6 P2) implemented per `02-specification.md` scope. Final gate green. **Deferred / P3 (future specs):** passkeys + 2FA; invites + viewer/operator roles; contextual cloud prompts; cloud organizations; WorkOS enterprise SSO/SCIM. **Carried design deviations (not defects):** `dorkos cloud logout` clears the local token but can't self-revoke server-side (cloud revoke is session-guarded; human revokes from `/account/instances`); two-service device-link E2E covered by integration tests rather than cross-service Playwright.

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
- **`BETTER_AUTH_SECRET`** must be set in production for both instances (server + site); documented in config docs + `.env.example`. Cloud `getAuth()` now fails closed (32+ char secret + non-localhost URL required in production).
- **`DORKOS_ALLOW_INSECURE_BIND`** (default false) is a narrow, loud-logging opt-out of the non-loopback bind gate, set only by `Dockerfile.integration` / `Dockerfile.run` (the container owns the network boundary). Real machines still hit the hard gate. Review-scrutinized.
- **CLI registration hook duplicated** (~15 lines) in `packages/cli` `createOwnerAuth` with a lock-step TSDoc note, because the CLI cannot cleanly reuse the server `createAuth` (its `trustedOrigins` touches uninitialized server singletons at CLI runtime).
- **`cli.ts` is 508 lines** (max-lines is a warn-level soft cap at 500; non-blocking). Splitting the CLI entry is a separate refactor.
- **better-auth resolves to 1.6.23** across server/site/cli (declared `^1.6`). A transitive `better-auth@1.4.21` copy exists in `.pnpm` via an unrelated dependency; our code does not use it.
