---
slug: accounts-and-auth
number: 268
created: 2026-07-02
status: specified
---

# Accounts & Auth: OSS Login Foundation + DorkOS Cloud Identity

**Status:** Draft
**Author:** Dorian + Claude
**Date:** 2026-07-02

## Overview

Add an identity system to DorkOS in two connected parts:

1. **OSS login foundation (P1):** Better Auth embedded in `apps/server`, providing an optional single-owner login for self-hosted instances. Off by default (zero-config local startup preserved), automatically required when the instance is exposed beyond localhost. Subsumes the tunnel passcode and replaces the global `dork_mcp_*` key with per-user scoped API keys.
2. **DorkOS accounts (P2):** an account-first cloud identity at dorkos.ai (Better Auth on Neon Postgres inside `apps/site`), with an RFC 8628 device-link flow that attaches local instances to a DorkOS account and a dashboard to view and revoke linked instances.

The two parts share one identity codebase (Better Auth) but are independent systems: a local login never leaves the machine, and a DorkOS account is the durable identity that instances attach to. Identities are never migrated between them. Organizations, enterprise SSO (WorkOS), and hosted instances are explicitly designed-for attach points, not part of this spec.

Product naming: the cloud identity is a **"DorkOS account"** in all product copy. The local credential is just "login," unnamed.

## Background / Problem Statement

DorkOS has no account system. Today's auth surface is machine-level: an optional 6-digit tunnel passcode with cookie sessions (`middleware/tunnel-auth.ts`), an optional global MCP Bearer key (`middleware/mcp-auth.ts`), and ephemeral `X-Client-Id` UUIDs for session write-locks. There is no user concept in either database.

This blocks three product directions: (a) safely exposing an instance beyond localhost with real credentials instead of a 6-digit PIN, (b) DorkOS Cloud, whose first shape is a coordination layer over local instances (remote access, relay/mesh, notifications, marketplace identity) and which requires durable accounts that instances authenticate to, and (c) the eventual enterprise tier (orgs, SAML SSO, SCIM), which must attach to an existing identity core.

Provider selection was settled by adversarially-verified research (`research/20260702_auth_providers_oss_vs_managed.md`): Better Auth is the only maintained embeddable TypeScript auth library (Lucia deprecated 2025; Auth.js in maintenance mode under Better Auth's own stewardship), with documented Express 5, Drizzle, and SQLite support. WorkOS standalone SSO/SCIM is the verified bolt-on pattern for the enterprise layer later. The industry-standard open-core split (verified across n8n, Grafana, Metabase, PostHog) gates features, not headcount: login and multi-user free; SSO/SCIM/RBAC paid.

## Goals

- Optional owner login for self-hosted instances; zero-config local startup unchanged when auth is off.
- Auth automatically required whenever the instance is exposed beyond localhost (tunnel or non-loopback bind).
- One auth path: Better Auth subsumes the tunnel passcode (config deprecated via migration) and the cookie-session middleware.
- Per-user scoped API keys (Better Auth `apiKey` plugin) replace the global `dork_mcp_*` key for MCP and machine access; `MCP_API_KEY` env override retained for headless use.
- Multi-user-capable schema from day one; registration auto-closes after the first user (owner). Invites ship later as a fast-follow, not here.
- Local accounts never require SMTP or email verification (n8n lesson; offline-first).
- DorkOS accounts at dorkos.ai: email/password + social sign-in, email verification via Resend.
- Device-link flow (RFC 8628 via Better Auth's `deviceAuthorization` plugin): link a local instance to a DorkOS account from the CLI or web client; instance registry with revocation in the account dashboard.
- Client (SPA/Electron) authenticates via Better Auth session cookies through the existing `HttpTransport` seam; Obsidian `DirectTransport` remains unauthenticated in-process.

## Non-Goals

- Cloud organizations/teams (future spec; Better Auth `organization` plugin is the planned attach point).
- Enterprise SSO/SCIM (future spec; WorkOS standalone per-connection, one WorkOS Organization per enterprise customer).
- Hosted DorkOS instances.
- Invite UI and the viewer/operator role model (fast-follow spec; this spec only guarantees the schema does not preclude it).
- Billing, subscriptions, or any paid gating.
- First-run account prompts (no nameable benefits until Cloud features ship; contextual prompts only).
- Migrating identities between local SQLite and cloud Postgres (deliberately never done; instances link instead).
- Any handling of Anthropic/Claude credentials (delegate-to-host-login only, per `research/20260625_agent_auth_patterns_meta_harnesses.md`).

## Technical Dependencies

- **better-auth ^1.6** ([docs](https://better-auth.com/docs/introduction)): MIT, ESM-only, framework-agnostic. Documented [Express integration](https://better-auth.com/docs/integrations/express) (mount before `express.json()`), [Drizzle adapter](https://better-auth.com/docs/adapters/drizzle) (SQLite + Postgres).
  - [`apiKey` plugin](https://better-auth.com/docs/plugins/api-key): per-user keys, scoped permissions, expiration, built-in rate limiting, `verifyApiKey()` as session substitute. Secret returned only at creation.
  - [`deviceAuthorization` plugin](https://better-auth.com/docs/plugins/device-authorization): RFC 8628 device + user codes, verification URI, polling, approve/deny, default 30-minute code expiry, built-in rate limiting.
  - `passkey` and `twoFactor` plugins: fast-follow, not P1.
  - `organization` plugin: future cloud spec only.
- **@better-auth/cli**: generates the Drizzle schema for Better Auth's tables (`user`, `session`, `account`, `verification`, plus plugin tables).
- **Resend** (cloud only): transactional email for verification/reset on dorkos.ai. Local edition has zero email dependency.
- Existing: Express 5 (`apps/server`), Drizzle ORM (`packages/db` SQLite; `apps/site` Neon Postgres), TanStack Router/Query + Zustand (client), `conf`-backed config with semver migrations.
- **WorkOS**: referenced as the future enterprise federation layer; not a dependency of this spec.

## Detailed Design

### Architecture changes

**Local (P1).** Better Auth instance created in `apps/server/src/services/core/auth/` and mounted in `app.ts` at `/api/auth/*splat` **before** `express.json()` (Better Auth handles its own body parsing). It replaces the `cookie-session` middleware and `tunnel-auth.ts` entirely:

- `auth.enabled` (new config field, default `false`). When `false`, no auth middleware runs and the UI shows no user concept anywhere (progressive disclosure).
- When `true`, a session gate middleware protects `/api/*` and `/mcp`: a valid Better Auth session cookie **or** a valid API key (Bearer) is required. Exemptions: `/api/auth/*`, health/status endpoints, and the static SPA assets (the login screen must load).
- **Exposure enforcement:** starting a tunnel or binding to a non-loopback interface with `auth.enabled: false` and no users is a hard gate: the server refuses to expose and returns/logs an actionable error; the UI routes the user into owner-account creation first. This replaces the passcode's role.
- **Registration policy:** open only while the `user` table is empty. First registered user is the owner (`role: owner`). Afterwards `POST /api/auth/sign-up/*` is disabled (Better Auth `disableSignUp` toggled at runtime). A future invites spec reopens registration via invitation tokens only.
- **Password reset without email:** `dorkos auth reset-password` CLI command (machine access = owner-level trust) resets the owner password. No SMTP anywhere in the local path.

**Cloud (P2).** Better Auth instance in `apps/site` (Next.js route handler `app/api/auth/[...all]/route.ts`), Drizzle adapter on the existing Neon Postgres. Email/password with Resend-backed verification, plus GitHub and Google social sign-in at launch. The `deviceAuthorization` plugin runs here; dorkos.ai gains `/activate` (user-code entry + approve/deny), `/account` (profile), and `/account/instances` (linked-instance registry with revoke).

**Device link.** Local instance (CLI `dorkos cloud login` or client Settings) calls the site's device-authorization endpoint, receives `{ device_code, user_code, verification_uri }`, displays the code and opens the browser, then polls. On approval, the site issues the instance a **scoped API key** (Better Auth `apiKey` plugin on the cloud side, owned by the account, metadata identifying the instance) rather than a browser session. The local instance stores it via the config sensitive-field pattern and registers/heartbeats into the `instance` table. Revocation from `/account/instances` deletes the key server-side; the instance detects 401 on the next call and marks itself unlinked. P2 delivers linking, registry, and revocation; consuming features (relay, notifications, remote access) are later specs that ride this rail.

### Code structure & file organization

```
apps/server/src/services/core/auth/
  index.ts                 # Better Auth instance (drizzle adapter, apiKey plugin)
  session-gate.ts          # middleware: session cookie OR api key, exemption list
  exposure-guard.ts        # tunnel/non-loopback bind enforcement
  cloud-link.ts            # device-flow client + instance token lifecycle
packages/db/src/schema/auth.ts        # Better Auth tables (generated, then owned)
packages/shared/src/config-schema.ts  # auth.enabled, cloud.instanceToken (sensitive);
                                      # tunnel.passcodeHash/Salt deprecated via migration
apps/client/src/layers/features/auth/ # login screen, session state, settings panels
apps/site/src/app/api/auth/[...all]/  # cloud Better Auth handler
apps/site/src/app/(account)/          # /activate, /account, /account/instances
apps/site/src/db/schema.ts            # + Better Auth tables + instance table
packages/cli: dorkos auth <enable|reset-password>, dorkos cloud <login|logout|status>
```

Removed: `middleware/tunnel-auth.ts`, `lib/passcode-hash.ts`, `cookie-session` dependency and its config (`sessionSecret` retired; Better Auth manages its own session signing). `middleware/mcp-auth.ts` is rewritten to accept per-user API keys (env `MCP_API_KEY` still honored as a static override for headless deployments).

### API changes

- New: `ALL /api/auth/*` (server, Better Auth handler) and same on site.
- Changed: when `auth.enabled`, all `/api/*` and `/mcp` routes require session or API key; 401 JSON error shape matches existing error conventions.
- Config API: `auth.enabled` readable/writable; `POST /api/config/mcp/generate-key` deprecated in favor of `POST /api/auth/api-key` (Better Auth endpoint); a config migration converts an existing `mcp.apiKey` into a seeded owner API key so existing MCP clients keep working.
- `X-Client-Id` semantics unchanged: it identifies a client connection for session write-locks and now coexists with user identity (a user may hold locks from several clients).

### Data model changes

- **Local SQLite (`packages/db`):** `user`, `session`, `account`, `verification`, `apikey` (Better Auth-generated via `@better-auth/cli`, checked into `schema/auth.ts`).
- **Cloud Postgres (`apps/site`):** the same Better Auth core tables + `deviceAuthorization` plugin tables + `instance` (`id`, `userId`, `name`, `platform`, `dorkosVersion`, `createdAt`, `lastSeenAt`, `revokedAt`). Account tables are fully separate from `marketplaceInstallEvents`; the telemetry no-PII contract is untouched (no join keys from telemetry to accounts).

### Integration with external libraries

Better Auth mounting (server): `app.all('/api/auth/*splat', toNodeHandler(auth))` placed above `express.json()`. Client: `createAuthClient` from `better-auth/client` wrapped behind the existing `Transport` seam; `HttpTransport` fetches gain `credentials: 'include'`. Resend integration is cloud-only, via Better Auth's `sendVerificationEmail`/`sendResetPassword` hooks.

## User Experience

1. **Default local use: nothing changes.** No login screen, no user concept, instant start.
2. **Enabling login:** Settings → Security → "Require login". Creates the owner account (email + password; email is an identifier only, never verified locally). Sessions persist per Better Auth defaults (7-day cookie, sliding refresh).
3. **Exposing the instance:** starting a tunnel (or non-loopback bind) with auth off routes into the same owner-creation flow with copy: "Exposing DorkOS requires a login." The passcode entry screen is removed; remote visitors get the login screen.
4. **API keys:** Settings → Security → API keys: create/name/revoke scoped keys (MCP, scripts, agents). Key value shown once.
5. **Linking a DorkOS account:** Settings → DorkOS account → "Link this instance" (or `dorkos cloud login`): shows an 8-character code, opens `dorkos.ai/activate`, user signs in (or signs up) and approves. The instance shows linked-account state; dorkos.ai `/account/instances` lists it with last-seen and a Revoke button.
6. **Error/exit paths:** login rate limiting with clear retry-after copy; expired device codes offer regenerate; revoked instances surface "This instance was unlinked" with a re-link action; `dorkos auth reset-password` for a lost local password; sign-out everywhere via session revocation list.

## Testing Strategy

- **Unit (server):** session-gate allows/blocks by cookie, API key, and exemption list; exposure-guard blocks tunnel start when auth off; registration closes after first user; config migration converts passcode/mcp-key fields correctly.
- **Integration (server, supertest):** full sign-up → sign-in → authed API call → sign-out cycle against the Express app with in-memory SQLite; MCP request with per-user API key and with `MCP_API_KEY` env override; 401 shape on missing/invalid credentials; SSE stream (`/api/sessions/:id/events`) authenticates correctly.
- **Client (RTL + mock Transport):** login screen renders when transport reports 401; auth-off mode renders no user affordances; API-key management flows; device-link settings flow with mocked codes.
- **Site:** route tests for `/activate` approve/deny and `/account/instances` revoke; Resend mocked at the email-hook seam.
- **E2E (Playwright, `apps/e2e`):** enable login → sign in → session persists across reload → sign out. Device-link covered by integration tests (two-service E2E deferred).
- **Mocking:** Resend mocked everywhere; device-flow polling tested with fake timers; no test may depend on real network or real dorkos.ai.

## Performance Considerations

Session lookup adds one SQLite read per authenticated request; enable Better Auth's cookie cache (signed short-TTL session snapshot) to avoid a DB hit on hot paths like SSE reconnect and high-frequency polling. API-key verification uses the plugin's built-in rate limiting and its expired-key sweep. Auth-off mode adds zero overhead (middleware not mounted).

## Security Considerations

- Password hashing: Better Auth default (scrypt); existing passcode hashes are discarded (not migrated) since the passcode system is removed; users re-establish credentials.
- Cookies: httpOnly, secure in production, sameSite=lax (device flow and OAuth callbacks require lax), signed. `trust proxy` set when tunneled so secure cookies survive the ngrok hop.
- CSRF: Better Auth origin checking; `trustedOrigins` = localhost dev origins + tunnel URL (reusing the dynamic CORS callback logic in `app.ts`).
- Brute force: Better Auth built-in rate limiting on sign-in and device endpoints; device codes expire in 30 minutes with polling backoff.
- Instance tokens: scoped API keys, never full sessions; revocable server-side; stored locally via the config sensitive-field pattern (same handling as `tunnel.authtoken` today).
- Trust-domain honesty: docs state plainly that anyone who can drive agents on an instance effectively has the server process's filesystem access and spends the owner's Claude quota. This is why registration is owner-only until the viewer/operator model exists.
- Anthropic credentials are never touched, proxied, or stored by any part of this system.
- Cloud/telemetry separation: no identifiers flow from account tables into `marketplaceInstallEvents`.

## Documentation

- `docs/` (user-facing): "Securing your instance" (login, exposure, API keys), "DorkOS accounts & linking instances"; update tunnel docs to remove passcode flow.
- `contributing/`: new `authentication.md` guide (architecture, both Better Auth instances, session-gate, device link); update `configuration.md` (new fields + migration), `architecture.md` (auth in the transport story).
- `CHANGELOG.md`: breaking-change note for passcode removal with migration explanation.
- Config JSON-schema docs regenerate from the Zod schema.

## Implementation Phases

- **Phase 1 (OSS foundation):** Better Auth in `apps/server` + `packages/db` schema; session-gate + exposure-guard; registration policy; passcode/cookie-session removal + config migration; per-user API keys + MCP integration; client login UI + settings; CLI `dorkos auth *`; Electron verification; docs.
- **Phase 2 (DorkOS accounts):** Better Auth in `apps/site` + Neon schema; Resend; sign-up/sign-in + `/account`; `deviceAuthorization` plugin + `/activate`; instance registry + revocation; local `cloud-link.ts` + CLI `dorkos cloud *`; client linking UI; docs.
- **Phase 3 (fast-follows, separate specs):** passkeys + 2FA; invites + viewer/operator roles for server-mode instances; contextual cloud prompts once cloud features ship; cloud organizations; WorkOS enterprise SSO/SCIM.

## Open Questions

- ~~Where does cloud identity live?~~ **(RESOLVED)** Answer: `apps/site` first, on the existing Neon Postgres. Rationale: zero new infrastructure; Better Auth is framework-agnostic so later extraction to a dedicated service is a deployment change, not a rewrite. (User decision 2026-07-02.)
- ~~Email provider for cloud accounts?~~ **(RESOLVED)** Answer: Resend. Rationale: developer-first, first-class Vercel/Next.js + React Email integration, free tier covers launch volume; local edition never sends email. (User decision 2026-07-02.)
- ~~Product naming?~~ **(RESOLVED)** Answer: "DorkOS account"; local credential is just "login". Rationale: one durable identity spanning marketplace/cloud/desktop, GitHub/Tailscale convention. (User decision 2026-07-02.)
- ~~Does Better Auth support the device flow and per-user API keys natively?~~ **(RESOLVED)** Answer: yes, both are first-party plugins (`deviceAuthorization`, RFC 8628; `apiKey` with scoping/expiry/rate limiting), verified against live docs 2026-07-02. Rationale: no custom protocol work required.
- ~~Electron: session cookie or loopback token?~~ **(RESOLVED)** Answer: session cookie (renderer loads from the local server origin, so cookies behave as in a browser); per-user API key is the documented fallback if packaged-build testing surfaces cookie issues. Rationale: one client auth path; the fallback needs no new machinery.
- WorkOS free-tier compliance guarantees (SOC 2 report access, EU data residency): deferred to the enterprise-SSO spec; verify before enterprise positioning. (Non-blocking here.)
- Exact viewer/operator permission semantics: deferred to the invites fast-follow spec. (Non-blocking; this spec only keeps the schema multi-user-capable.)

## Related ADRs

- ADR-0311: Embed Better Auth as the single identity core across OSS and Cloud (draft, this spec)
- ADR-0319: Account-first cloud identity: instances device-link to DorkOS accounts (draft, this spec)
- ADR-0320: Optional-by-default local login, auto-required on exposure (draft, this spec)
- ADR-0321: WorkOS standalone SSO/SCIM as the enterprise federation layer (draft, this spec)
- ADR-0304: file-scoped transactions for marketplace installs (pattern precedent for config migrations)

## References

- `specs/accounts-and-auth/01-ideation.md` (decisions table, trust-model analysis)
- `research/20260702_auth_providers_oss_vs_managed.md` (provider evaluation, verified pricing, refuted claims)
- `research/20260324_tunnel_passcode_auth_system.md` (system being subsumed)
- `research/20260625_agent_auth_patterns_meta_harnesses.md` (Claude credential ToS boundary)
- Better Auth: [introduction](https://better-auth.com/docs/introduction) · [Express](https://better-auth.com/docs/integrations/express) · [api-key plugin](https://better-auth.com/docs/plugins/api-key) · [device-authorization plugin](https://better-auth.com/docs/plugins/device-authorization) · [organization plugin](https://better-auth.com/docs/plugins/organization)
- WorkOS: [pricing](https://workos.com/pricing) · [standalone SSO docs](https://workos.com/docs/sso)
- n8n user-management precedent: [docs](https://docs.n8n.io/deploy/host-n8n/configure-n8n/user-management)
