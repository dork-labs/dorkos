---
title: 'Auth Systems for DorkOS: OSS Auth Model, Better Auth vs Competitors, WorkOS vs Managed Providers'
date: 2026-07-02
type: external-best-practices
status: active
tags:
  [
    auth,
    accounts,
    better-auth,
    workos,
    sso,
    saml,
    scim,
    organizations,
    open-core,
    n8n,
    clerk,
    auth0,
    keycloak,
    pricing,
    cloud,
  ]
feature_slug: accounts-and-auth
searches_performed: 40
sources_count: 53
---

# Auth Systems for DorkOS: OSS Auth Model, Better Auth vs Competitors, WorkOS vs Managed Providers

## Research Summary

DorkOS has no account system today. This report evaluates (1) how successful OSS devtools split auth between their free self-hosted edition and their cloud edition, (2) the open-source/self-hostable auth landscape with Better Auth in depth, (3) the managed provider landscape with WorkOS in depth, (4) the OSS-vs-managed tradeoff for a small team shipping both an OSS product and a future cloud SaaS, and (5) a concrete recommendation.

Methodology: a deep-research workflow (5 search angles, 24 sources fetched, 119 claims extracted, 25 adversarially verified with 3-vote refutation, 21 confirmed / 4 killed) plus two supplementary landscape surveys (OSS libraries/servers; managed providers) and a codebase map of DorkOS's existing auth seams. All pricing was live-verified July 2026 and can drift; re-check before signing anything.

**Bottom line:** Embed Better Auth in the OSS server as an optional single-owner login (n8n's model, but optional). Reuse the same Better Auth core for DorkOS Cloud with its organization plugin, and bolt on WorkOS standalone SSO + Directory Sync per enterprise customer when that demand arrives. Every link in that chain was independently verified, and the industry precedent (n8n, Grafana, Metabase, PostHog on the model; LobeHub on the provider choice) is strong.

---

## Part 1: The Auth Model - How OSS Devtools Split Auth Across Tiers

### n8n (the model the user asked about) - verified 3-0

- Since v1.0, the email-based **owner login is mandatory and cannot be disabled**. `N8N_USER_MANAGEMENT_DISABLED`, basic auth, and JWT auth were all removed; n8n docs state "no supported way to disable the login screen exists."
- The free Community edition is **not single-user**: the owner can invite unlimited additional users. Since v0.210.1 SMTP is optional (invite links can be copied manually). The Aug 2025 pricing announcement confirms unlimited users on every plan including Community.
- **The open-core gate is on features, not headcount.** What n8n actually gates into paid tiers (all verified verbatim against live docs):
  - Cross-user **sharing** of workflows/credentials (Community: only owner + creator can access)
  - The **admin** account type (Community has only owner and member)
  - **RBAC and projects** ("available on all plans except the Community edition")
  - **SSO in both SAML and LDAP forms** (Business/Enterprise only)

Sources: [n8n user management docs](https://docs.n8n.io/deploy/host-n8n/configure-n8n/user-management), [Community edition features](https://docs.n8n.io/deploy/host-n8n/community-edition-features), [account types](https://docs.n8n.io/administer/manage-users-and-access/understand-account-types), [RBAC](https://docs.n8n.io/administer/manage-users-and-access/set-permissions-and-roles-rbac), [SAML](https://docs.n8n.io/administer/manage-users-and-access/verify-user-identity/use-saml). Note: old `/hosting/...` doc URLs 404; content moved to `/deploy/host-n8n/...` and `/administer/...`.

### The same split across Grafana, Metabase, PostHog - verified 3-0

- **Grafana**: basic LDAP authentication stays OSS; Enterprise gates LDAP background sync, team sync, datasource permissions, SAML, RBAC.
- **Metabase**: OSS edition has **no user limits** ("Free unlimited users"). Nuance: basic Google SSO and LDAP are free in OSS; the paid gate is **SAML/JWT** SSO plus row/column permissions (Pro, ~$500/mo).
- **PostHog**: SAML on Scale ($750/mo) and Enterprise only; even _SSO enforcement_ (blocking password login) requires Boost ($250/mo) or above.

**The industry-standard open-core auth split: login and multi-user are free; enterprise SSO (SAML), directory sync (SCIM), RBAC, and admin/governance features are paid.** Gating basic multi-user is the exception, not the norm.

Refuted along the way (do not cite these): "Grafana added SAML in v6.4 to Enterprise" (1-2 vote, detail wrong); "Metabase gates all SSO to Pro" (0-3, Google SSO/LDAP are free); a specific PostHog SCIM-tiering claim (0-3).

Sources: [Grafana Enterprise docs](https://grafana.com/docs/grafana/latest/introduction/grafana-enterprise/), [Grafana 2019 differentiation post](https://grafana.com/blog/2019/09/04/how-we-differentiate-grafana-enterprise-from-open-source-grafana/), [Metabase pricing](https://www.metabase.com/pricing/), [PostHog SSO docs](https://posthog.com/docs/settings/sso), [PostHog platform packages](https://posthog.com/platform-packages).

---

## Part 2: Open-Source / Self-Hostable Auth Landscape

### The constraint that decides everything

DorkOS ships as an npm CLI users run locally (SQLite, no Docker requirement). Only an **embeddable in-process TypeScript library** fits the OSS edition. Every standalone identity server (separate process + Postgres) is disqualified for the OSS core, though several remain candidates as cloud-side infrastructure.

### Better Auth (in depth) - verified 3-0

- Framework-agnostic, universal TypeScript auth framework, delivered as an **embedded library** ("your auth lives in your codebase"). MIT license, ~28.9k stars, v1.6.23 (Jun 2026), ESM-only (matches our `type: module` server).
- **Documented Express v5 integration** (mount at `/api/auth/*splat`; the handler must be mounted _before_ `express.json()`).
- DB via adapters including **Drizzle and SQLite** - exactly DorkOS's stack. Automatic schema migrations.
- Ships free: email/password, social sign-on, session management, 2FA, passkeys, built-in rate limiter, and an **organization plugin** (owner/admin/member roles, custom roles, invitations, teams).
- Caveats: orgs are a bundled plugin, not zero-config core; GitHub issues #2167 (no ABAC) and #4557 (dynamic-role limits) qualify access-control depth.
- **Refuted (1-2 vote): the claim that Better Auth's plugin ecosystem covers the full enterprise ladder including enterprise SSO/IdP.** Its SSO/SAML/SCIM plugins exist but their enterprise-grade maturity is unproven. Do not plan to skip WorkOS on the strength of Better Auth's SSO plugin without a hands-on evaluation.
- **Stewardship consolidation (verified on both sides, 3-0)**: as of Sep 22, 2025, the Better Auth team maintains Auth.js/NextAuth, which is in maintenance mode (security patches only). The nextauthjs README and maintainer balazsorban44 (GitHub Discussion #13252) both recommend new projects start with Better Auth; authjs.dev hosts an official migration guide. Choosing Auth.js for a new 2026 project is choosing a maintenance-mode library.

Sources: [Better Auth intro](https://better-auth.com/docs/introduction), [Express integration](https://better-auth.com/docs/integrations/express), [organization plugin](https://better-auth.com/docs/plugins/organization), [Auth.js joins Better Auth](https://better-auth.com/blog/authjs-joins-better-auth), [nextauthjs repo](https://github.com/nextauthjs/next-auth).

### The rest of the OSS field (supplementary survey, not adversarially verified)

| Project              | Architecture                                                | License                                                                                  | Verdict for DorkOS                                                                                                 |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Lucia**            | Was a library; deprecated Mar 2025, now a learning resource | -                                                                                        | Dead as a dependency. Do not adopt.                                                                                |
| **Auth.js/NextAuth** | Embeddable, has `@auth/express`                             | ISC                                                                                      | Maintenance mode; its own steward points to Better Auth.                                                           |
| **Keycloak**         | Standalone Java/Quarkus server + Postgres                   | Apache 2.0                                                                               | Most mature IAM anywhere (35.5k stars, Red Hat-backed) but 512MB-2GB JVM; wrong for npm CLI, heavy even for cloud. |
| **Ory Kratos/Hydra** | Two headless Go services, BYO UI                            | Apache 2.0 core; **SAML/org-SSO/SCIM gated behind Ory Enterprise License for self-host** | License fence + DIY UI; pass.                                                                                      |
| **Zitadel**          | Single Go binary + Postgres                                 | AGPL-3.0                                                                                 | Best native multi-tenancy of the servers; candidate for cloud-side IdP later, not OSS core.                        |
| **Logto**            | TS/Node service + Postgres (Docker Compose)                 | MPL-2.0                                                                                  | Most stack-aligned standalone server; best "grows-with-you" server pick if Cloud ever wants a dedicated IdP.       |
| **Authentik**        | Python/Django server + Postgres                             | MIT; SAML/OIDC/LDAP/SCIM/passkeys all free (most generous OSS parity)                    | Great turnkey self-hosted IdP; not embeddable.                                                                     |
| **SuperTokens**      | Node SDKs + **separate Java core service**                  | Apache 2.0                                                                               | The friendly Node SDK hides a JVM sidecar; same disqualifier as Keycloak.                                          |
| **Hanko**            | Go server + Postgres, passkey-first                         | MIT frontend, **AGPL backend**                                                           | Disproportionate for a single-owner login.                                                                         |
| **Stack Auth**       | Docker bundle (API + Next.js dashboard + Postgres)          | MIT/AGPL dual                                                                            | Mid-rebrand to "Hexclave" (auth+payments+emails platform); roadmap churn = risky dependency.                       |

Ranked alternatives to Better Auth if it ever falters: **Logto** (TS alignment, first-class orgs), **Authentik** (feature-complete free IdP to federate to), **Zitadel** (org-native, single binary). All three are standalone servers, i.e. cloud-side options only.

Sources: [Lucia deprecation](https://github.com/lucia-auth/lucia/discussions/1714), [Zitadel](https://github.com/zitadel/zitadel), [Logto](https://github.com/logto-io/logto), [Authentik](https://github.com/goauthentik/authentik), [SuperTokens core](https://github.com/supertokens/supertokens-core), [Hanko](https://github.com/teamhanko/hanko), [Hexclave](https://www.hexclave.com/), [Ory OSS page](https://www.ory.com/open-source), [Skycloak 2026 comparison](https://skycloak.io/blog/open-source-authentication-comparison-2026/).

---

## Part 3: Managed Provider Landscape

### WorkOS (in depth) - pricing verified live 2026-07-02, 3-0

- **AuthKit** (full user management): **free for the first 1,000,000 MAUs**, then $2,500/mo per additional 1M. MAU = any sign-up/sign-in/profile-update in a calendar month.
- **Enterprise SSO and Directory Sync (SCIM): priced separately and identically, per connection per month**: $125/ea (1-15 connections), $100 (16-30), $80 (31-50), $65 (51-100), $50 (101-200), custom 201+. Cost maps 1:1 onto enterprise-tier revenue.
- **The bolt-on pattern is an explicitly supported product, not a hack (3-0, the most load-bearing finding)**: WorkOS documents its SSO product as "a standalone API for integrating into an existing auth stack" that "acts as authentication middleware and intentionally does not handle user database management for your application." WorkOS's own content ("How to add SSO to your homegrown auth in a day") and practitioner reports (Knock) describe the pattern in production.
- Strategic caveat: WorkOS publishes a "Migrate from the standalone SSO API" doc nudging new integrations toward AuthKit, but that doc commits to continued support of the standalone API.
- Unverified gap: WorkOS data-residency/compliance guarantees at the free tier (SOC 2, EU hosting) were not confirmed by this research; verify before enterprise positioning.

Sources: [WorkOS pricing](https://workos.com/pricing), [WorkOS SSO docs](https://workos.com/docs/sso), corroborated by [SuperTokens](https://supertokens.com/blog/workos-alternatives) and [Scalekit](https://scalekit.com/blog/workos-alternatives) third-party breakdowns.

### Competitors (supplementary survey, pricing from live pages July 2026)

| Provider                   | Free tier                                   | ~10k MAU             | ~100k MAU              | SSO/SCIM model                                                 | Key liability                                                                                         |
| -------------------------- | ------------------------------------------- | -------------------- | ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| WorkOS AuthKit             | 1M MAU                                      | $0                   | $0                     | $125/conn (SSO=SCIM), tiers to $50                             | nudge toward AuthKit lock-in                                                                          |
| Auth0 (Okta)               | none for B2B ($150/mo base)                 | ~$815/mo, 3-conn cap | custom quote           | bundled but **connection-capped** below Enterprise; SCIM extra | 2024 pricing shock (overage $0.023 to $0.07/MAU; 15.5x bill case study); post-Okta support complaints |
| Clerk                      | 50k MRU, **no SSO**                         | ~$25/mo              | ~$1,025/mo + conn fees | $75/conn (2-15) to $15 (500+); SCIM GA only Apr 2026           | 5+ public outage postmortems in 12 months                                                             |
| Stytch                     | 10k MAU + **5 SSO/SCIM conns free**         | $0                   | usage-based            | $125/conn beyond 5 free                                        | EU residency unclear                                                                                  |
| Descope                    | 7,500 MAU, 3 conns                          | $249/mo              | $799/mo base           | **SCIM gated to $799/mo Growth**                               | SSO/SCIM economics worse than WorkOS                                                                  |
| FusionAuth                 | unlimited-MAU **self-host free incl. SAML** | $0 self-host         | ~$800-3,000/mo cloud   | SAML in every tier; **SCIM Enterprise-only**                   | you own ops                                                                                           |
| AWS Cognito                | 10k MAU                                     | ~$0-30/mo            | ~$1,500/mo             | SAML MAU-billed; **no native SCIM**                            | **password hashes cannot be exported**; no B2B org primitive                                          |
| Firebase/Identity Platform | 50k MAU                                     | $0                   | ~$230-460/mo           | SAML 50 MAU free then $0.015/MAU                               | proprietary scrypt variant on hash export forces resets                                               |
| Supabase Auth              | 50k MAU                                     | ~$25/mo              | ~$25/mo + overage      | Team $599/mo is the fixed-price SSO tier                       | only sensible if adopting Supabase wholesale                                                          |

**Bolt-on SSO specialists** (the WorkOS-standalone-SSO pattern, useful as fallbacks): **Scalekit** (free: 1M MAU, 100 orgs, 1 SSO + 1 SCIM conn; explicitly a drop-in layer over existing auth), **SSOReady** (YC W24, open-source middleware, doesn't own the user table, self-hostable), **Ory Polis** (ex-BoxyHQ SAML Jackson, OSS SAML-to-OIDC bridge + SCIM 2.0, self-hostable).

Ranked for DorkOS Cloud: 1) **WorkOS** (1M-MAU free runway + uncapped per-connection SSO/SCIM + mature Express/React SDKs), 2) **Stytch** (only true pricing-philosophy peer, 5 free connections; bake-off candidate), 3) **FusionAuth self-hosted** (hedge that caps vendor risk entirely at the cost of owning ops). Losers: Auth0 (caps + pricing shock), Clerk (reliability + immature SCIM), Cognito/Firebase (hash lock-in, no B2B primitives), Descope (SCIM gate), Supabase (backend coupling).

Sources: [Auth0 pricing](https://auth0.com/pricing), [Auth0 pricing-change fallout](https://securityboulevard.com/2025/09/auth0-support-after-okta-what-developers-are-saying-in-2025/), [Clerk pricing](https://clerk.com/pricing), [Clerk postmortems](https://clerk.com/blog/2026-03-10-service-outage-postmortem), [Stytch pricing](https://stytch.com/pricing), [Descope pricing](https://www.descope.com/pricing), [FusionAuth pricing](https://fusionauth.io/pricing), [Cognito pricing](https://aws.amazon.com/cognito/pricing/), [Cognito hash lock-in](https://docs.aws.amazon.com/cognito/latest/developerguide/managing-users-passwords.html), [Identity Platform pricing](https://cloud.google.com/identity-platform/pricing), [Supabase pricing](https://supabase.com/pricing), [Scalekit](https://www.scalekit.com/), [SSOReady](https://github.com/ssoready/ssoready), [Ory Polis](https://www.ory.com/polis).

---

## Part 4: OSS Auth vs Managed Auth for DorkOS

### Why the OSS core cannot use a managed provider

A self-hostable OSS product cannot make its free edition depend on a third-party auth SaaS: it breaks offline/air-gapped use, adds a signup wall to a local tool, couples every OSS user to DorkOS's vendor contract, and contradicts the honest-by-design brand. **Real-world precedent (verified 3-0): LobeHub (large OSS self-hostable AI app) migrated ALL auth off managed Clerk and NextAuth onto Better Auth in Jan 2026** - RFC, official migration guide, migration script, and merged PR #11711 removing Clerk entirely; LobeHub 2.0 supports only Better Auth. OSS self-hostable products converge on embedded OSS auth.

### Tradeoff summary

**Open-source embedded (Better Auth):**

- Pros: no per-MAU costs ever; works offline; data stays in the user's SQLite/Postgres; full control of schema and UX; same code path in OSS and Cloud; MIT license; our stack exactly (TS, Express 5, Drizzle, SQLite).
- Cons: we own security patching, session hardening, abuse protection; enterprise SSO/SCIM plugin maturity unproven (refuted claim); no vendor SLA or compliance paperwork to lean on; young project (v1.x) with fast-moving API.

**Managed (WorkOS et al):**

- Pros: zero-ops, SOC 2 paperwork, someone else's pager; enterprise SSO/SCIM battle-tested against real IdPs (Okta, Entra, Google Workspace quirks); free tiers cover startup scale.
- Cons: unusable for the OSS edition; per-connection/per-MAU costs at scale; lock-in (Cognito/Firebase hash-export traps are the cautionary extreme); pricing regime changes outside our control (Auth0 2024 is the cautionary tale); outages are your outages (Clerk 2025-26).

**The hybrid resolves the tradeoff**: own the identity core (Better Auth = system of record in both editions), rent exactly the commodity that is genuinely hard and enterprise-only (SAML federation + SCIM via WorkOS standalone, per-connection, cost mapped to enterprise revenue).

---

## Part 5: Recommendation for DorkOS

### Architecture

1. **OSS edition (now/near-term): Better Auth embedded in `apps/server`, optional single-owner login, off by default.**
   - Zero-config local UX is a core DorkOS value; unlike n8n we should NOT force a login for a local single-user tool. Make it opt-in (`dorkos auth enable` or setup prompt), and strongly encouraged/required only when exposing the server beyond localhost (it subsumes the tunnel passcode threat model with real credentials + sessions).
   - Better Auth's Drizzle adapter on our existing SQLite; sessions via its cookie session (we already run cookie-session for the tunnel passcode; consolidate).
   - Follow the industry norm if multi-user ever lands in OSS: gate features (orgs, RBAC, SSO), not headcount.
2. **DorkOS Cloud: same Better Auth core on Postgres (Neon), plus the organization plugin** for multi-user orgs (owner/admin/member, invitations, teams). One identity system of record across both editions; the cloud tier is a deployment + plugin configuration, not a different auth stack.
3. **Enterprise (later): WorkOS standalone SSO + Directory Sync bolted onto Better Auth** per enterprise customer. $125/connection/mo maps directly onto enterprise contract revenue. Fallbacks if WorkOS deprecates the standalone API or pricing shifts: Scalekit, SSOReady (OSS), Ory Polis (OSS) - the seam is a thin federation layer, so switching costs stay low.

### DorkOS-specific attach points (from the codebase map, 2026-07-02)

- `apps/server/src/middleware/tunnel-auth.ts` + `lib/passcode-hash.ts` + cookie-session in `app.ts:101-110`: the existing session machinery Better Auth would subsume.
- `HttpTransport` (`apps/client/.../http-transport.ts:54`): single constructor seam to carry credentials; today's `X-Client-Id` is an ephemeral UUID per page load.
- `packages/shared/src/config-schema.ts`: sensitive-field pattern + semver migrations already exist for auth config (`tunnel.passcodeHash`, `mcp.apiKey`, `sessionSecret`).
- `packages/db`: Drizzle SQLite schemas with no users table yet; Better Auth generates its own tables via the Drizzle adapter.
- `apps/site` (Neon Postgres + Drizzle): natural home for cloud accounts; currently anonymous-telemetry-only with an explicit no-PII contract that account data must not silently violate.
- Non-browser surfaces (CLI, Electron, Obsidian `DirectTransport`, `/mcp` API key): need a device-code flow / API-key story; none of the verified research covered machine auth (open question).

### Open questions before committing

1. Hands-on evaluation of Better Auth's SSO/SAML + SCIM plugins: could they eventually serve enterprise without WorkOS? (The claim they can was refuted 1-2; assume no until proven.)
2. Identity migration story from self-hosted (SQLite users) to DorkOS Cloud (Postgres orgs): account linking, session continuity, schema portability.
3. Machine/agent auth across CLI, Electron, Obsidian, MCP: device-code flow vs scoped API keys (extend the `dork_mcp_*` key pattern per-user?).
4. WorkOS free-tier compliance guarantees (SOC 2 report access, EU data residency) for enterprise positioning.

### Verification stats

Deep-research workflow: 5 angles, 24 sources fetched, 119 claims extracted, 25 adversarially verified (3-vote), 21 confirmed, 4 refuted, 9 synthesized findings; 106 agent calls. Supplementary surveys: OSS landscape (10 projects), managed landscape (8 providers + 3 bolt-on specialists). Refuted claims and their corrections are listed inline above; coverage gap: the deep-research pass produced no _verified_ claims for several named competitors, so those profiles rest on the (unverified but sourced) supplementary surveys.
