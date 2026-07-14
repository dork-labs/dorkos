# Authentication Guide

## Overview

DorkOS has one identity core — [Better Auth](https://better-auth.com) — embedded in two independent instances: a **local** instance in `apps/server` (optional single-owner login for self-hosted servers) and a **cloud** instance in `apps/site` (durable "DorkOS accounts" that local instances device-link to). This guide covers the local instance in depth (the P1 foundation) and points forward to the cloud instance (P2). The two share the library but never share a database and never migrate identities between them.

## Key Files

| Concept                                    | Location                                                    |
| ------------------------------------------ | ----------------------------------------------------------- |
| Local Better Auth instance                 | `apps/server/src/services/core/auth/index.ts`               |
| Session gate (the request gate)            | `apps/server/src/services/core/auth/session-gate.ts`        |
| Exposure guard (tunnel / bind)             | `apps/server/src/services/core/auth/exposure-guard.ts`      |
| Legacy MCP key seeding                     | `apps/server/src/services/core/auth/seed-legacy-mcp-key.ts` |
| MCP auth middleware (4-tier)               | `apps/server/src/middleware/mcp-auth.ts`                    |
| Trusted-origin resolver (CSRF)             | `apps/server/src/lib/trusted-origins.ts`                    |
| Auth SQLite schema                         | `packages/db/src/schema/auth.ts`                            |
| `auth.enabled` + `cloud.*` config          | `packages/shared/src/config-schema.ts`                      |
| Config migrations (0.49–0.51)              | `apps/server/src/services/core/config-manager.ts`           |
| CLI `dorkos auth <enable\|reset-password>` | `packages/cli/src/commands/auth-dispatcher.ts`              |
| Client auth slice                          | `apps/client/src/layers/features/auth/`                     |
| Cloud Better Auth instance (P2)            | `apps/site/src/lib/auth.ts`                                 |
| Cloud device-link client (P2)              | `apps/server/src/services/core/auth/cloud-link.ts`          |

## When to Use What

| You need to…                                         | Use                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| Gate a new `/api/*` route behind login               | Nothing — the app-wide `sessionGate` already covers `/api/*` |
| Read the authenticated user in a handler             | `res.locals.user` (`{ userId }`), set by the gate on success |
| Verify a credential outside the gate                 | `verifyRequestAuth(req)` (cookie → Bearer API key, one path) |
| Decide whether an instance may be exposed            | `canExpose()` / `isExposureAllowed(state)`                   |
| Check whether an owner account exists                | `hasAnyUser()`                                               |
| Accept a machine credential on `/mcp`                | `mcpApiKeyAuth` (env override → user key → legacy → open)    |
| Create the owner from a machine (no server, no SMTP) | `dorkos auth enable`                                         |
| Reset a lost owner password                          | `dorkos auth reset-password`                                 |

## Core Patterns

### The one gate, read per request

When `config.auth.enabled` is `true`, a single app-wide middleware (`sessionGate`) protects everything under `/api/*` and `/mcp`. When it is `false`, the gate is a zero-overhead pass-through — the flag is read **per request** via `configManager`, so the enable-login flow flips it without a server restart.

```typescript
// apps/server/src/services/core/auth/session-gate.ts (shape)
export async function sessionGate(req, res, next) {
  if (!configManager.get('auth')?.enabled) return next(); // zero-config: transparent

  const path = req.path.toLowerCase(); // Express routes case-insensitively; normalize BEFORE the check
  if (!isGatedPath(path)) return next(); // static SPA assets → login screen can load
  if (isExemptPath(path)) return next(); // /api/auth/* (sign-in) + /api/health

  const user = await verifyRequestAuth(req);
  if (user) {
    res.locals.user = user; // downstream handlers read res.locals.user
    return next();
  }
  res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
}
```

The gate is mounted **after** the Better Auth handler and `express.json()`, **before** the first API route. The `/mcp` mount (added in `index.ts`) is on the same app, so the app-wide gate covers it too.

### One verification path

`verifyRequestAuth(req)` is the single credential resolver: it tries the Better Auth **session cookie** first (the cookie cache keeps hot paths like SSE reconnect off the DB), then a per-user **API key** presented as `Authorization: Bearer <key>`. It never throws — a malformed cookie or a revoked key resolves to `null` (fail closed). Both the session gate and the MCP middleware reuse it, so there is exactly one place credentials are checked.

### Owner-only registration

The auth instance is always mounted (even when `auth.enabled` is `false`) so the enable-login flow can create the owner before flipping the flag. A `databaseHooks.user.create.before` hook enforces the policy: sign-up succeeds only while the `user` table is empty, and the first user is stamped `role: 'owner'`. Every later sign-up throws `FORBIDDEN` / `REGISTRATION_CLOSED`. The schema stays multi-user-capable for the future invites spec.

### Exposure guard: BOTH facts required

An instance may be exposed beyond localhost — an ngrok tunnel, or a non-loopback `app.listen` bind — only when `auth.enabled` **and** an owner account exists. Requiring both is deliberate: `auth.enabled: false` means the gate never runs, so even with users on disk the API is open, and exposure must stay blocked.

```typescript
export function isExposureAllowed(state: ExposureState): boolean {
  return state.authEnabled === true && state.hasUsers === true;
}
```

Two enforcement points consume it:

- **Tunnel start** (`routes/tunnel.ts`) and the boot-time autostart (`index.ts`) call `canExpose()`; on `false` they respond `409 { code: 'AUTH_REQUIRED_FOR_EXPOSURE' }` (and skip the autostart). The client (`features/auth`) matches on `AUTH_REQUIRED_FOR_EXPOSURE` to route the operator into owner-account creation, then retries the tunnel.
- **Non-loopback bind** (`index.ts`) calls `checkBindAllowed({ host, exposureAllowed, allowInsecureBind })` before `app.listen`. A non-loopback host with the guard failing **refuses to start** (hard gate, non-zero exit) with an actionable message. `DORKOS_ALLOW_INSECURE_BIND=true` is a narrow, loud-logging escape hatch set only by the container images (the `integration` and `runtime` targets of the root `Dockerfile`), which own the network boundary.

### MCP: 4-tier resolution + legacy seeding

`mcpApiKeyAuth` keeps the JSON-RPC 401 shape MCP clients expect and resolves credentials in priority order:

1. `env.MCP_API_KEY` — static override for headless deployments (exact match, un-revocable).
2. A per-user Better Auth API key (or session cookie) via `verifyRequestAuth`.
3. Legacy compat: a not-yet-seeded `config.mcp.apiKey`, accepted until seeding retires it.
4. Nothing configured and login disabled → pass through (localhost-only, the historical zero-config behavior).

The old global `dork_mcp_*` key is folded into a per-user key by `seedLegacyMcpApiKey(db)`, run on the owner-creation seam and at startup. It inserts the exact key value as an owner-owned Better Auth key (via the plugin's `defaultKeyHasher`) and clears `config.mcp.apiKey` in the same operation — idempotent, so existing MCP clients keep working without a restart. The removed `POST /api/config/mcp/generate-key` and `DELETE /api/config/mcp/api-key` endpoints are replaced by the Better Auth `/api/auth/*` API-key endpoints (client UI in `features/auth`). `GET /api/config` now reports the MCP `authSource` as `'env' | 'user-keys' | 'none'`.

### Cookies, CSRF, and the tunnel hop

Cookies are `httpOnly`, `secure` in production, `sameSite: 'lax'` (the P2 device flow and OAuth callbacks require `lax`). `app.set('trust proxy', 1)` keeps `secure` cookies correct behind the ngrok hop. The CSRF/origin surface is `trustedOrigins`, resolved per request by `resolveTrustedOrigins()` (loopback dev origins + the live tunnel origin) — the same dynamic policy shared with the CORS allowlist. `BETTER_AUTH_SECRET` (or `AUTH_SECRET`) signs sessions; production deployments must set it so sessions survive restarts (`baseURL` is intentionally omitted because the origin is dynamic).

### Client wiring

The client auth slice (`features/auth`) exposes Better Auth only through hooks (`useSignIn`, `useSignUp`, `useSignOut`, `useCurrentUser`, `useApiKeys`) so no component imports the library directly. `AuthGuard` renders `LoginScreen` when the app-wide auth-required signal is set (a gated request returned `401 AUTH_REQUIRED`); otherwise it is a transparent pass-through (progressive disclosure — no user affordances appear when login is off). It is wired into the web shell (`main.tsx`) only; Obsidian embedded mode (`DirectTransport`, in-process) never mounts it and stays unauthenticated. `HttpTransport`'s fetch paths send `credentials: 'include'` so the session cookie rides along. See `contributing/architecture.md` for the Transport story.

## Config fields & migrations

| Field                      | Type           | Default | Notes                                                         |
| -------------------------- | -------------- | ------- | ------------------------------------------------------------- |
| `auth.enabled`             | boolean        | `false` | Whether local login is required (progressive-disclosure gate) |
| `cloud.instanceToken`      | string \| null | `null`  | Scoped instance API key from the cloud (**sensitive**), P2    |
| `cloud.instanceName`       | string \| null | `null`  | This instance's name registered with the cloud, P2            |
| `cloud.linkedAccountLabel` | string \| null | `null`  | Human-readable linked-account label, P2                       |

Three semver-keyed, idempotent migrations in `config-manager.ts` (append-only; see `contributing/configuration.md` → Schema Migrations):

- **`0.49.0` `backfillAuthDefaults`** — writes `auth: { enabled: false }` when absent.
- **`0.50.0` `dropTunnelPasscodeAndSessionSecret`** — deletes the retired `tunnel.passcodeEnabled` / `tunnel.passcodeHash` / `tunnel.passcodeSalt` and root `sessionSecret`. Better Auth manages its own session signing; old passcode hashes are discarded, not migrated.
- **`0.51.0` `backfillCloudDefaults`** — writes the all-`null` `cloud` section when absent (P2).

`mcp.apiKey` remains in the schema (and in `SENSITIVE_CONFIG_KEYS`) for the seeding compat window; removing it is deferred to a later config-schema cleanup once seeding has shipped in a release.

## CLI recovery

Machine access equals owner-level trust, so both commands operate directly on the local SQLite DB and `~/.dork/config.json` — no running server, no SMTP:

- `dorkos auth enable` — creates the owner (prompts, or `--email`/`--password`/stdin for non-TTY), then sets `auth.enabled: true`. Errors cleanly if an owner already exists. A running server must be restarted to pick up the change (the CLI writes `config.json` directly; the server's in-process `conf` cache does not watch the file).
- `dorkos auth reset-password` — resets the owner credential (hidden, confirmed). The dispatcher builds a CLI-local `createOwnerAuth(db)` that mirrors the server's Better Auth config so scrypt hashing and table shapes match exactly.

## Anti-Patterns

```typescript
// ❌ NEVER add a second credential-verification path
const session = await auth.api.getSession({ headers }); // duplicates the gate
// ✅ reuse the one shared resolver
const user = await verifyRequestAuth(req);

// ❌ NEVER cache config.auth.enabled at module load
const enabled = configManager.get('auth')?.enabled; // frozen — needs a restart to flip
// ✅ read it per request inside the middleware so enable-login takes effect live

// ❌ NEVER gate a path by its display name or mixed case
if (req.path === '/API/Sessions') {
  /* bypassed by lowercase routes */
}
// ✅ normalize first: const path = req.path.toLowerCase()

// ❌ NEVER expose an instance on auth.enabled alone
if (configManager.get('auth')?.enabled) startTunnel(); // open API if no gate + no users
// ✅ require BOTH facts
if (canExpose()) startTunnel();

// ❌ NEVER mount express.json() before the Better Auth handler
app.use(express.json());
app.all('/api/auth/*splat', toNodeHandler(auth)); // breaks body parsing
// ✅ mount the auth handler FIRST (Better Auth parses its own body)
```

## Troubleshooting

### `401 { error: 'Unauthorized', code: 'AUTH_REQUIRED' }` on every `/api/*` call

**Cause:** `auth.enabled` is `true` and the request carries no valid session cookie or API key.
**Fix:** Sign in (the client shows `LoginScreen` automatically), or send `Authorization: Bearer <api-key>`. In tests, build the app without calling `initAuth` so `verifyRequestAuth` returns `null` only when intended, or sign in against a temp DB.

### `409 { code: 'AUTH_REQUIRED_FOR_EXPOSURE' }` when starting a tunnel

**Cause:** The exposure guard blocked exposure — either `auth.enabled` is `false` or no owner account exists.
**Fix:** Enable login and create an owner (Settings → Security, or `dorkos auth enable`), then retry.

### Server refuses to start with a `DORKOS_HOST` bind message

**Cause:** `DORKOS_HOST` is a non-loopback address but login is not configured (hard bind gate).
**Fix:** Run `dorkos auth enable` (then restart), or, only for a container that owns its network boundary, set `DORKOS_ALLOW_INSECURE_BIND=true`.

### "Base URL is not set" advisory at startup

**Cause:** Expected — `baseURL` is intentionally omitted because the server is reachable on both loopback and a dynamic tunnel origin. Harmless (email/password + API keys only; no OAuth redirects).
**Fix:** None. Origin policy lives in `trustedOrigins`.

## Cloud instance (P2): DorkOS accounts

The cloud identity is a **second, fully independent Better Auth instance** in `apps/site` (`apps/site/src/lib/auth.ts`), running on Next.js and Neon Postgres via the Drizzle `pg` adapter. It is the durable **"DorkOS account"** that local instances device-link to. It shares the Better Auth library with the local instance but **never shares a database**, and identities are **never migrated** between the two.

### The two-identity model

|                              | Local login (P1)                      | DorkOS account (P2)                        |
| ---------------------------- | ------------------------------------- | ------------------------------------------ |
| Where                        | `apps/server`, SQLite (`packages/db`) | `apps/site`, Neon Postgres                 |
| Purpose                      | Gate one self-hosted instance         | Durable cloud identity instances attach to |
| Email verification           | Never (identifier only, no SMTP)      | Required (Resend)                          |
| Social sign-in               | No                                    | GitHub + Google                            |
| Credential a client holds    | Session cookie                        | —                                          |
| Credential an instance holds | —                                     | Scoped API key (`cloud.instanceToken`)     |

They are **orthogonal**: `auth.enabled` (local) and being linked to a DorkOS account are independent — either can exist without the other, so nothing in the cloud-link path reads `auth.enabled`. A user account never moves from SQLite to Postgres or back; instances _link_ instead.

### Cloud auth instance

`createAuth(adapter)` (`apps/site/src/lib/auth.ts`) is the exported factory (tests build it over `memoryAdapter`; production uses the Neon `pg` adapter). It configures:

- `emailAndPassword` with `requireEmailVerification: true`. Verification and reset email are confined to the mailer seam (`apps/site/src/lib/mailer.ts`, `sendVerificationEmail` / `sendResetPassword`) so tests mock the module, never the network.
- GitHub + Google social providers (`GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`).
- The **`deviceAuthorization`** plugin (RFC 8628, 8-character user codes, 30-minute expiry) and the **`apiKey`** plugin (`enableMetadata: true`, so each key carries its instance descriptor).
- **`resolveBaseURL()`** picks the public origin Better Auth serves from: production and local use the explicit `BETTER_AUTH_URL`; **preview deploys self-derive it from Vercel's `VERCEL_BRANCH_URL`** (the stable per-branch alias) so every preview authenticates against its own origin without a hardcoded value. Preview also adds the branch + per-deploy URLs to `trustedOrigins` (scoped to our own Vercel hosts, never a blanket `*.vercel.app`). `BETTER_AUTH_URL` is therefore set only in Production; Preview/Development leave it unset.
- `assertProductionAuthEnv()` fails closed at request time (never at `next build`): production requires a 32+ char `BETTER_AUTH_SECRET` and validates the **resolved** origin is non-localhost (a preview's localhost `BETTER_AUTH_URL` is fine because the origin derives from the branch URL), so a misconfigured deploy cannot sign sessions with Better Auth's predictable development fallback.

The Next.js handler mounts at `apps/site/src/app/api/auth/[...all]/route.ts` via `toNextJsHandler(auth)`.

### Device-link sequence

A local instance links via `cloud-link.ts` + `CloudLinkManager` (or `dorkos cloud login` / the Settings panel). The cloud base URL is `resolveCloudBaseUrl()` (`env.DORKOS_CLOUD_URL`, default `https://dorkos.ai`; override for local dev against the site):

1. **Request a code** — the instance calls `POST /api/auth/device/code`; the cloud returns `{ device_code, user_code, verification_uri, interval, expires_in }`. The instance shows the 8-character `user_code` and opens `verification_uri` (`dorkos.ai/activate`).
2. **Approve** — the user signs in (or up) at `/activate` and approves. `/activate` requires a session (redirects to `/signin?returnTo=…`) and shows the requesting instance before Approve/Deny.
3. **Poll → key swap** — the instance polls `POST /api/auth/device/token`, honoring `interval` / `slow_down` (RFC 8628). By default that route mints a **browser session** on approval; an instance must instead hold a revocable, account-scoped API key. The `after` hook on `/device/token` (`apps/site/src/lib/auth.ts`) does the swap: it mints an instance API key (`createInstanceApiKey`, metadata = the instance descriptor), **deletes the just-created session**, strips `set-cookie`, and rewrites the body to `{ access_token: <key>, token_type: 'Bearer', scope: 'instance' }`. Denial → `access_denied`; expiry → `expired_token`.
4. **Store + heartbeat** — the instance stores the key at `config.cloud.instanceToken` (sensitive-field pattern, same handling as `tunnel.authtoken`) and calls `POST /api/instances/heartbeat` on startup and every 15 minutes with `{ name, platform, dorkosVersion }`. The heartbeat creates/refreshes the instance's `instance` row (`lastSeenAt`) and returns the owning account label, persisted to `config.cloud.linkedAccountLabel`.

### The `instance` registry table

`apps/site/src/db/instance-schema.ts` — one row per linked instance: `id` (uuid pk, **equals** the `instanceId` in the owning API key's `metadata`, so a heartbeat carrying only the key can find its row), `userId` (intra-cluster FK → `user`, `onDelete: cascade`), `name`, `platform`, `dorkosVersion`, `createdAt`, `lastSeenAt`, `revokedAt` (null while live). Rendered at `/account/instances`.

Hard-isolated from `marketplaceInstallEvents`: no foreign key, join column, or shared identifier crosses the account ↔ telemetry boundary. Enforced by `apps/site/src/db/__tests__/schema.test.ts` (telemetry has zero foreign keys; no account table references telemetry; account-cluster foreign keys stay within `user/session/account/verification/apikey/deviceCode/instance`).

### Revocation semantics (→ 401)

Revoke from `/account/instances` (or `POST /api/instances/revoke`, ownership-enforced). `revokeInstance` (`apps/site/src/lib/instance-service.ts`) **deletes the owning API key** so it immediately stops verifying, and stamps `instance.revokedAt`. The instance detects the `401` on its next heartbeat, and `CloudLinkManager` clears `config.cloud.instanceToken`, sets the `unlinked` state with reason `"This instance was unlinked"`, and stops the heartbeat timer — no retry-loop on a dead key. `dorkos cloud logout` / `POST /api/cloud/unlink` is best-effort local: it clears the local token but cannot self-revoke (cloud revoke is session-guarded; a human revokes from `/account/instances`).

### Local wiring

- **Config:** the `cloud` section (`packages/shared/src/config-schema.ts`) — `instanceToken` (sensitive), `instanceName`, `linkedAccountLabel`; migration `0.51.0` `backfillCloudDefaults`.
- **Local routes:** `apps/server/src/routes/cloud.ts` — `POST /api/cloud/link/start`, `GET /api/cloud/link/status` (`idle | pending | linked | expired | denied | unlinked`), `POST /api/cloud/unlink`, `GET /api/cloud/status`.
- **CLI:** `dorkos cloud login | logout | status` (`packages/cli/src/commands/cloud-dispatcher.ts`) — the device flow talks directly to the cloud, so it works headless.
- **Client:** the Settings → "DorkOS account" panel (`apps/client/src/layers/features/cloud-link/`) drives the four `Transport` cloud methods (`cloud-methods.ts`); it is visible regardless of local login. Obsidian `DirectTransport` stubs them.

See `specs/accounts-and-auth/02-specification.md` for the full design and `contributing/configuration.md` for the config + env-var reference.

## Cloud account management (DOR-187)

Layered on the cloud instance: an admin surface, self-serve account lifecycle,
and an audit trail. Cloud-only — the local single-owner server has none of this.
Full design in `specs/cloud-account-management/02-specification.md`.

### Admin plugin

The Better Auth [`admin`](https://better-auth.com/docs/plugins/admin) plugin
(`admin()` in `lib/auth.ts`, `adminClient()` in `lib/auth-client.ts`) provides
ban/unban, impersonate, revoke sessions, set role/password, list/search, and hard
remove — all through Better Auth's typed API (`auth.api.*` / `authClient.admin.*`),
never raw SQL. A single **`admin`** role grants every operation (no custom access
controller); `defaultRole` stays `user`, so self-registrations are never admin.

**Break-glass promote.** No admin exists to promote the first admin, so two
mechanisms bootstrap it:

- `ADMIN_USER_IDS` (env, comma-separated user ids) grants full admin regardless of
  `role` — the zero-state seed; set the founder's `user.id` at launch.
- A durable one-time promotion is a break-glass `UPDATE "user" SET role='admin'
WHERE id='…'` via the **Neon SQL editor** (the only sanctioned raw-SQL touch).

**Ban vs delete.** Prefer **ban** (reversible; revokes sessions) for moderation;
reserve hard `removeUser` / self-serve delete for genuine erasure. Better Auth's
`banUser` revokes _sessions_ but not _API keys_, so `lib/admin-audit-hook.ts` also
**disables the banned account's API keys** (`enabled: false`) — otherwise a banned
user's linked instances would keep authenticating heartbeats.

### Self-serve delete + export (GDPR/CCPA)

At `/account` (the `DangerZone` in `features/account`):

- **Delete my account** → `authClient.deleteUser()`. Because `user.deleteUser`
  configures `sendDeleteAccountVerification`, deletion requires an emailed token
  (a hijacked session cannot silently erase). On confirmation the `onDelete:
cascade` chain (`session`/`account`/`apikey`/`instance` → `user`) erases
  everything; a linked instance 401s on its next heartbeat and self-unlinks.
- **Export my data** → `GET /api/account/export` (`lib/account-service.ts`)
  assembles the caller's own rows into a portability JSON. **Secrets are never
  exported** — password hashes, OAuth tokens, and API-key values are stripped.

### accountLinking (D-A)

`account.accountLinking` is enabled with `trustedProviders: ['google', 'github',
'email-password']` and `allowDifferentEmails: false`, so a social sign-in with the
same **verified** email links to the existing account rather than creating a
duplicate ("my instances vanished"). Verified-email-only linking closes the
classic auto-link account-takeover vector.

### Audit log

`audit_log` (`db/audit-schema.ts`, written via `lib/audit-service.ts`) is an
append-only record of every admin action and self-serve deletion (actor, action,
target, reason, metadata, time). It has **no foreign key to `user`** — the trail
must outlive a GDPR-erased account, so it is deliberately outside the cascade
cluster and stays hard-isolated from install telemetry. Impersonation is audited
explicitly and also stamped on `session.impersonatedBy`.

### Cleanup jobs (DOR-194)

A daily Vercel Cron (`crons` in `apps/site/vercel.json`, `0 4 * * *`) hits
`GET /api/cron/cleanup`, which runs `runCleanup` (`lib/cleanup-service.ts`) over
the account tables through the Better Auth adapter. One idempotent pass:

- **Purges never-verified accounts** — `user` rows still `emailVerified = false`
  after 7 days (`UNVERIFIED_USER_TTL_MS`). The `user` delete cascades its
  sessions/OAuth links/API keys/instances via the schema FKs. Expired one-time
  `verification` tokens are swept alongside (they key by `identifier`, never
  `userId`, so they can't be correlated to an account — deleting the expired ones
  is the honest sweep, mirroring Better Auth's own lazy cleanup).
- **Deletes expired device codes** — `deviceCode` rows past `expiresAt`.
- **Auto-revokes stale instances** — `instance` rows silent for 30 days
  (`STALE_INSTANCE_TTL_MS`) are **revoked, not deleted**: the same
  `revokeInstance` path a human uses (delete the owning API key, stamp
  `revokedAt`), so the row survives at `/account/instances` as "revoked" history
  instead of silently vanishing. Fresh/live instances are never touched.

It returns per-category counts (`{ unverifiedUsers, expiredDeviceCodes,
staleInstances }`) and writes one best-effort `system.cleanup` audit row when a
run removes anything.

**The `CRON_SECRET` gate.** The route requires `Authorization: Bearer
<CRON_SECRET>` (Vercel Cron sends this when the env var is set). `CRON_SECRET` is
optional in `env.ts`, but the route **fails closed**: unset (or a mismatch) → 401,
so it can never be triggered unauthenticated. Set a strong random value in the
deployment.

**Before any manual bulk run, branch Neon first.** `runCleanup` is destructive
(it deletes accounts). Validate on a Neon branch — or invoke `runCleanup(auth, {
dryRun: true })`, which reports the counts it _would_ remove without mutating
anything — before running it against production data by hand.

### Key files (cloud account management)

| Concept                           | Location                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Admin plugin + delete/link config | `apps/site/src/lib/auth.ts`                                                      |
| Admin-action audit + ban hook     | `apps/site/src/lib/admin-audit-hook.ts`                                          |
| Audit log service                 | `apps/site/src/lib/audit-service.ts`                                             |
| Scheduled cleanup service         | `apps/site/src/lib/cleanup-service.ts`                                           |
| Cleanup cron route + schedule     | `apps/site/src/app/api/cron/cleanup/route.ts`, `apps/site/vercel.json`           |
| Audit table + registry plugin     | `apps/site/src/db/audit-schema.ts`, `apps/site/src/lib/audit-registry-plugin.ts` |
| Data export service               | `apps/site/src/lib/account-service.ts`                                           |
| Export route                      | `apps/site/src/app/api/account/export/route.ts`                                  |
| Client admin + delete wrapper     | `apps/site/src/lib/auth-client.ts`                                               |
| `/account` Danger Zone UI         | `apps/site/src/layers/features/account/ui/DangerZone.tsx`                        |
| Admin columns + `impersonatedBy`  | `apps/site/src/db/auth-schema.ts`                                                |

### Runbook: destructive ops

Before any bulk destructive operation (mass ban, bulk delete) or a schema change
touching the auth tables, **create a Neon branch** and validate there first. The
admin columns migration (`drizzle/0004_*`) is additive (nullable columns +
`role` defaulted), so it backfills existing rows safely.
