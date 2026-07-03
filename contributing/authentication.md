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
| Config migrations (0.47–0.49)              | `apps/server/src/services/core/config-manager.ts`           |
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
- **Non-loopback bind** (`index.ts`) calls `checkBindAllowed({ host, exposureAllowed, allowInsecureBind })` before `app.listen`. A non-loopback host with the guard failing **refuses to start** (hard gate, non-zero exit) with an actionable message. `DORKOS_ALLOW_INSECURE_BIND=true` is a narrow, loud-logging escape hatch set only by the container images (`Dockerfile.integration`, `Dockerfile.run`), which own the network boundary.

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

- **`0.47.0` `backfillAuthDefaults`** — writes `auth: { enabled: false }` when absent.
- **`0.48.0` `dropTunnelPasscodeAndSessionSecret`** — deletes the retired `tunnel.passcodeEnabled` / `tunnel.passcodeHash` / `tunnel.passcodeSalt` and root `sessionSecret`. Better Auth manages its own session signing; old passcode hashes are discarded, not migrated.
- **`0.49.0` `backfillCloudDefaults`** — writes the all-`null` `cloud` section when absent (P2).

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

## Cloud instance (P2) — forward pointer

The cloud identity is a second, fully independent Better Auth instance in `apps/site` (Next.js, Neon Postgres via the Drizzle `pg` adapter), with `emailAndPassword` (verification required, Resend at the mailer seam), GitHub + Google social sign-in, and the `deviceAuthorization` + `apiKey` plugins. Account tables are hard-isolated from `marketplaceInstallEvents` (no shared identifiers; the telemetry no-PII contract is untouched).

A local instance links to a DorkOS account via the RFC 8628 device flow (`cloud-link.ts` + `dorkos cloud login`): the instance requests a device code, the user approves at `dorkos.ai/activate`, and the cloud issues the instance a **scoped API key** (owned by the account, never a browser session) that the instance stores at `config.cloud.instanceToken` and uses to heartbeat `POST /api/instances/heartbeat`. Revoking from `/account/instances` deletes the key; the instance detects `401` on its next call and marks itself unlinked. Local login (P1) and cloud link (P2) are independent systems — neither depends on the other, and identities are never migrated between the local SQLite and cloud Postgres stores.

This section is expanded by the Phase 2 documentation task (device-flow sequence, instance table, revocation semantics, the two-identity model). See `specs/accounts-and-auth/02-specification.md` for the full design.
