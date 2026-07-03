---
slug: accounts-and-auth
number: 268
created: 2026-07-02
status: ideation
---

# Accounts & Auth: OSS Login Foundation + DorkOS Cloud Identity

**Slug:** accounts-and-auth
**Author:** Dorian + Claude
**Date:** 2026-07-02

---

## 1) Intent & Assumptions

- **Task brief:** DorkOS has no account system. Add authentication such that (a) the free OSS edition gains an optional, honest login for self-hosted instances without sacrificing zero-config local startup, and (b) DorkOS Cloud gets an account-first identity layer that local instances link to, ready to grow organizations and enterprise SSO later. Provider direction was settled by research: Better Auth embedded in the OSS core; WorkOS standalone SSO/SCIM bolted onto Cloud for enterprise (see `research/20260702_auth_providers_oss_vs_managed.md`).
- **Assumptions:**
  - DorkOS Cloud will be **both** shapes eventually: a coordination layer over local instances first (remote access, relay/mesh, notifications, marketplace identity), with hosted instances possible later. Identity must therefore be **account-first**: the cloud account is the durable identity; instances attach to it.
  - The OSS edition stays free and full-powered. Open-core gates are on **features, not headcount** (verified industry norm: n8n, Metabase, Grafana, PostHog).
  - Agents run on the user's machine with the user's Claude subscription; that does not change.
  - All pricing/vendor facts referenced were live-verified 2026-07-02 in the research report.
- **Out of scope (designed-for, but later specs):**
  - Cloud organizations/teams (Better Auth `organization` plugin on Cloud).
  - Enterprise SSO/SCIM via WorkOS (one WorkOS account; one WorkOS Organization per enterprise customer; $125/connection/mo at current tiers).
  - Hosted DorkOS instances.
  - Fine-grained per-user permissions beyond the minimal viewer/operator split named below.
  - Billing/subscriptions.

## 2) Pre-reading Log

- `research/20260702_auth_providers_oss_vs_managed.md`: the provider decision and its evidence. Key verified facts: Better Auth is the only maintained embeddable TS auth library (Lucia dead, Auth.js in maintenance mode under Better Auth stewardship); documented Express 5 + Drizzle + SQLite support; org/2FA/passkey plugins free. WorkOS standalone SSO is an explicitly supported bolt-on pattern. Better Auth's own enterprise SSO/SCIM plugin maturity was REFUTED in verification; do not plan to skip WorkOS with it.
- `research/20260324_tunnel_passcode_auth_system.md`: the existing tunnel passcode design (6-digit PIN, scrypt, cookie sessions, rate limiting). Single-user, developer-tool threat model. This system is subsumed by real auth in this spec.
- `research/20260625_agent_auth_patterns_meta_harnesses.md`: delegate-to-host-login is the only ToS-safe path for Claude credentials; DorkOS accounts must never touch Anthropic auth.
- n8n precedent (verified): owner login mandatory since v1.0; Community edition allows unlimited invited users; SMTP optional (manual invite links). Paid gates are sharing/RBAC/admin/SAML, not user count. Lesson adopted: local signup must never require SMTP.

## 3) Codebase Map

- **Primary components:**
  - `apps/server/src/middleware/tunnel-auth.ts` + `apps/server/src/lib/passcode-hash.ts`: current passcode gate; to be replaced by Better Auth sessions.
  - `apps/server/src/app.ts:101-110`: cookie-session middleware (`dorkos_session`, httpOnly, sameSite=strict, secret in config); Better Auth's session management replaces this usage.
  - `apps/server/src/middleware/mcp-auth.ts`: global `dork_mcp_*` Bearer key; migrates to per-user scoped API keys (Better Auth `apiKey` plugin), keeping env-var override for headless use.
  - `packages/shared/src/transport.ts` + `apps/client/.../http-transport.ts:54`: `HttpTransport` constructor is the single client seam for credentials; today's `X-Client-Id` is an ephemeral UUID and stays (it identifies a client connection, not a user).
  - `apps/client/src/layers/shared/lib/direct-transport.ts`: Obsidian/embedded in-process transport; same trust domain as the host process, stays unauthenticated.
  - `packages/shared/src/config-schema.ts`: sensitive-field + semver-migration pattern for new auth config (`auth.enabled`, cloud link token ref); `tunnel.passcodeHash`/`passcodeSalt` deprecated via migration.
  - `packages/db/src/schema/`: local SQLite (Drizzle); gains Better Auth tables (`user`, `session`, `account`, `verification`) via its Drizzle adapter, plus an `instance_link` record for the cloud attachment.
  - `apps/site/src/db/schema.ts`: Neon Postgres; natural first home for cloud identity (Better Auth on Postgres). Existing telemetry table has an explicit no-PII contract; account tables are new, separate, and must not leak identity into the telemetry path.
- **Data flow:** client (SPA/Electron) → Better Auth session cookie → Express routes; CLI/MCP/agents → per-user API key → same identity; local instance → device-link token → DorkOS Cloud.
- **Feature flags/config:** `auth.enabled` (default false); exposure detection (tunnel active or non-localhost bind) forces `auth.enabled: true`.
- **Potential blast radius:** every Express route (session middleware ordering; Better Auth handler must mount **before** `express.json()`), tunnel UX, MCP endpoint auth, Electron packaged app (needs the session cookie or a loopback token), onboarding, config migrations, `X-Client-Id` session-locking semantics (unchanged but now coexists with user identity).

## 4) Research

- **Potential solutions considered** (full analysis in the research report):
  1. Managed auth in the OSS core (Clerk/Auth0/WorkOS AuthKit everywhere). Rejected: breaks offline/self-hosted use; LobeHub migrated off Clerk to Better Auth for exactly this reason (Jan 2026).
  2. Standalone OSS identity server (Keycloak, Zitadel, Logto, Authentik...). Rejected for OSS core: DorkOS ships as an npm CLI; a separate server + Postgres is disproportionate. Logto/Zitadel remain candidates only if Cloud someday wants a dedicated IdP.
  3. **Embedded Better Auth in OSS + same core in Cloud + WorkOS bolt-on for enterprise SSO (chosen).** One identity codebase across editions; enterprise cost scales per paying connection.
- **Recommendation:** Solution 3, with the account-first cloud identity model (instances link to cloud accounts via device flow; identities are never migrated between local SQLite and cloud Postgres).

## 5) Decisions

| #   | Decision                   | Choice                                                                                                                                                                                                                          | Rationale                                                                                                                                                                                                                                |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Auth provider architecture | Better Auth embedded (OSS + Cloud core); WorkOS standalone SSO/SCIM for Cloud enterprise later                                                                                                                                  | Research-verified: only maintained embeddable TS option; WorkOS bolt-on is a documented supported pattern; costs map to enterprise revenue                                                                                               |
| 2   | Cloud shape for identity   | Both eventually: coordination layer first, hosted instances possible later; identity is **account-first** (cloud account durable, instances attach)                                                                             | User decision 2026-07-02. Dissolves the SQLite→Postgres identity-migration problem: link instances, never migrate identities                                                                                                             |
| 3   | Spec scope                 | OSS login foundation **and** cloud identity (accounts at dorkos.ai + device-link) in this spec; orgs/SSO/hosted later                                                                                                           | User decision 2026-07-02                                                                                                                                                                                                                 |
| 4   | OSS user model             | Full-power OSS: multi-user **schema** from day one; owner-only registration at first ship (signups auto-disabled after first user); invites become a fast-follow gated on server-mode UI + a minimal viewer/operator role model | User direction: no headcount crippling, but invites on a laptop are confusing and a DorkOS "operator" shares the machine's trust domain (agents = filesystem + owner's Claude quota). Progressive disclosure resolves the confusion risk |
| 5   | Login posture              | Optional, off by default; **required automatically when exposed** (tunnel/LAN); no first-run prompt until Cloud benefits exist, then contextual prompts at the moment of value                                                  | User's test: prompt only with nameable benefits. At OSS ship time the honest benefits list is empty; contextual prompts convert better and stay honest                                                                                   |
| 6   | Tunnel passcode fate       | Better Auth subsumes it; passcode config deprecated via migration                                                                                                                                                               | Less-but-better: one auth path; a 6-digit PIN is strictly weaker than real credentials on the same cookie plumbing                                                                                                                       |
| 7   | Machine/agent auth         | Per-user scoped API keys (Better Auth `apiKey` plugin) replace the global `dork_mcp_*` key; `DirectTransport` (Obsidian/embedded) stays unauthenticated in-process                                                              | One identity model across MCP/CLI/agents; embedded mode is the same trust domain as the host process                                                                                                                                     |
| 8   | Local signup independence  | Local accounts must never require SMTP/email verification                                                                                                                                                                       | n8n lesson (verified); offline-first is non-negotiable for OSS                                                                                                                                                                           |

## 6) Proposed Architecture (sketch for SPECIFY)

- **Local (OSS):** Better Auth mounted in `apps/server` (before `express.json()`), Drizzle adapter on existing SQLite. Email/password (+ passkeys as fast-follow), no email verification locally. `auth.enabled` config flag; exposure forces it on. Owner = first user; registration then closes.
- **Cloud:** Better Auth on Neon Postgres (initial home: `apps/site`), social sign-in + email, verification via an email provider (needs selection). Account is the durable identity.
- **Device link:** OAuth 2.0 Device Authorization Grant-style flow (`dorkos cloud login` or UI button → short code → dorkos.ai/activate → instance receives a scoped, revocable instance token stored via the config sensitive-field pattern). Cloud dashboard lists linked instances (Tailscale-style), revocable per instance. Local login and cloud link are independent; either can exist without the other.
- **Future attach points (not built now):** cloud `organization` plugin for teams; WorkOS Organization per enterprise customer with Admin Portal self-setup; instances attachable to an org for fleet identity.

## 7) Risks & Open Questions

- **Trust-model honesty:** an operator on a shared instance effectively has the server process's filesystem access and spends the owner's Claude quota. Invite UX and docs must say this plainly; the viewer/operator split is the minimum bar for shipping invites.
- **Better Auth device-authorization support:** confirm the current plugin's state (device flow) or spec a minimal RFC 8628-style implementation; also verify passkey plugin fit for Electron.
- **Cloud identity home:** `apps/site` (Next.js on Vercel) vs a new `apps/cloud` service; recommendation is site-first, but relay/tunnel brokering may later want a runtime service. Decide at SPECIFY.
- **Email provider for Cloud** (verification/magic links): needs selection (e.g. Resend); local edition must not depend on it.
- **Electron packaged app:** session cookie vs loopback token for the local HTTP surface; verify with the packaged-build work (see desktop app state).
- **Naming:** "DorkOS account" vs "DorkOS Cloud account" in product copy.
- **WorkOS compliance guarantees** at free tier (SOC 2 report access, EU residency): verify before enterprise positioning.
- **Tracker projection:** this work is currently untracked; per flow, projection was skipped silently. Create the Linear item (project + umbrella) at DECOMPOSE or when work is claimed.

## 8) Recommended Next Step

Proceed to **SPECIFY** (`/flow:specify accounts-and-auth`): produce `02-specification.md` covering the P1 (OSS login foundation, tunnel subsumption, per-user API keys) and P2 (cloud accounts + device link + instance registry) scope, with orgs/SSO as explicitly-designed-for attach points.
