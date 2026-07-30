---
title: 'Connections UX Critique — Direct-First Redesign Evidence (DOR-745)'
date: 2026-07-29
type: research
status: active
tags: [connectors, connections, ux, mcp, oauth, composio, direct-connect]
---

> Adversarial design critique of the shipped /connections surface (post connector-completion program), produced by a standing design-critic agent with live screenshots, live API probes (vendor OAuth registration, Google Workspace MCP endpoints), and web fact-checks. Screenshots referenced below lived in the producing session's scratchpad and are not committed; the findings stand alone. Feeds: specs/connections-redesign, specs/direct-connect, ADR 260729-234626.

# DorkOS `/connections` — Design Critique & Brief

**Date:** 2026-07-29 · **Reviewer:** design-critic (standing critic for this surface) · **Round:** 1 (consolidated, all corrections merged)

Scope: the shipped `/connections` surface, its server-side connector layer, and the strategic question of how DorkOS should acquire user account connections. All facts below were verified first-hand (live cockpit, repo source, live HTTP probes) or cited to primary vendor documentation. Where a claim could not be resolved, it says so.

**Screenshots** (view these — they carry the argument):

| File                                                                                                                                       | What                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/c1c1c681-de20-45ae-a2b7-f1807a40caf4/scratchpad/connections-desktop.png` | `/connections`, 1440×900, full page, light                               |
| `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/c1c1c681-de20-45ae-a2b7-f1807a40caf4/scratchpad/connections-mobile.png`  | `/connections`, 390×844, full page                                       |
| `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/c1c1c681-de20-45ae-a2b7-f1807a40caf4/scratchpad/connections-dark.png`    | `/connections`, 1440×900, dark — **captures the live 401 failure state** |
| `/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/c1c1c681-de20-45ae-a2b7-f1807a40caf4/scratchpad/home-desktop.png`        | Dashboard, for design-language context                                   |

---

## (a) Screenshot observations — worst three first

### 1. The page is lying to the founder right now, and it has a green badge on the lie

Between the light and dark captures the state changed — a Composio key was saved. Live API, at review time:

```
GET /api/connectors/providers → composio: configured:true, registered:true   → badge renders "Ready"
GET /api/connectors/toolkits  → {"toolkits":[],"warnings":[]}
GET /api/connectors/accounts  → {"accounts":[],"warnings":[]}
```

`~/.dork/logs/dorkos.log`:

```
23:07:12 [Connectors] Composio managed backend registered
23:07:12 [Connectors] composio listToolkits degraded: Composio request failed (401).
23:07:12 [Connectors] composio listAccounts degraded: Composio request failed (401).
... repeating through 23:10:09
```

Composio is rejecting the key with a **401**. The UI's rendering of that: a green **"Ready"** badge, **"API key saved"**, and a Services panel reading **"No services to connect yet — Add a provider key under Providers below."** Every one of those is false or actively misdirecting. Three minutes of repeated retries in the log say a human sat there clicking.

**Root cause is structural, not incidental.** `registry.ts:_aggregate` records a warning only when a provider's promise **rejects**:

```ts
// registry.ts (~line 320)
if (result.status === 'fulfilled') { items.push(...result.value); }
else { warnings.push({ provider: provider.type, message: … }); }
```

`providers/composio.ts:listToolkits` is deliberately "throw-free": it catches, logs, returns `[]` → `Promise.allSettled` reports `fulfilled` → **no warning is ever produced**. The comment at `composio.ts:144-146` claims _"The registry aggregation records a warning upstream."_ **That comment is false.** The throw-free provider contract silently defeats the ADR-0310 degradation machinery it was written to feed.

Separately, `bootstrap.ts:_statusFor` computes `configured` as "a credential resolves" and `registered` as "the provider object is in the registry." Neither asks whether the key _works_. **"Ready" means "we have a string."**

A rejected credential is the single most likely first-run failure, and it is the one the UI handles worst. This is not a cosmetic bug — it is the exact failure mode `be honest by design` exists to prevent, in the one place the product touches the user's real credentials.

### 2. Inverted information hierarchy: two dead ends on top, the only control buried below them

Reading order: **Services** (empty box, ~180px of nothing) → **Connected accounts** (one gray sentence) → **Providers** (the only thing you can touch). The page leads with two consequences and buries the cause. Worse, the two empty states point at each other — Services says "add a provider key below," Accounts says "pick a service above." A first-run user is bounced between two panels that both defer.

Counted from the DOM: the entire main content has **two** interactive elements in default state (two "Save key" buttons). That is the whole page. A control panel with nothing to control.

Mobile is materially worse: `md:grid-cols-2` collapses provider cards to one column, putting the only actionable element roughly 700px below the fold, under two empty states.

### 3. The first decision the page asks for is one the user cannot possibly make

Two side-by-side cards — "Composio" and "Nango" — presented as symmetrical peers with paste-a-key fields and no basis for choosing. Neither name means anything to Kai, let alone Ikechi. Nango's card is written in the present tense about a state that does not exist: _"You're connecting through your own Nango server."_ That is a custody disclosure repurposed as a setup description, and it reads as a confusing assertion about infrastructure the user does not have.

### Smaller findings worth fixing in the same pass

- **Breadcrumb bug:** the topbar reads **"Dashboard"** while on `/connections`. Likely affects every non-dashboard route.
- **Naming collision:** the Dashboard's DISCOVER card says **"Connect to Slack & Telegram"** (notification channels) while the sidebar says **"Connections"** (account connectors). Two concepts, one verb. Users will land on the wrong page.
- **Flat type hierarchy:** H1 20px, H2 14px, body 14px — three sections read as equal weight. Do **not** fix by enlarging headings (the cockpit is deliberately compact and Dashboard matches). Fix by deleting a section.
- **Dark mode is clean.** No issues found.
- **`SessionConnectorsGroup` returns `null`** when nothing is connected (`SessionConnectorsGroup.tsx:48`) — correct Calm Tech, but the session surface contributes **zero** discovery. The place a user _feels_ the need ("my agent can't see my email") shows nothing.
- **Icon poverty:** `SERVICE_ICONS` maps services to generic Lucide glyphs (`Mail`, `FileText`, `ListChecks`). `@dorkos/icons` has Telegram, Anthropic, OpenAI, OpenCode, Gemini, and a Slack glyph — **no Gmail, Notion, Linear, or GitHub marks.** This is why the grid reads as a settings form rather than a catalog.

---

## (b) Fact-check

### Composio

| Question                                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Programmatic key issuance for an end user** | **No.** No OAuth-for-API-access, no device flow, no PKCE, no key-vending or partner API. The only programmatic minting is `POST /api/v3.1/org/owner/project/new` with `should_create_api_key`, authenticated by an **org-owner key a human obtained from the dashboard** ([projects reference](https://docs.composio.dev/reference/api-reference/projects/postOrgOwnerProjectNew)). No org-creation API exists ([organization reference](https://docs.composio.dev/reference/api-reference/organization) exposes only usage analytics). For a local desktop app holding no vendor secret, **dashboard copy-paste is the only path.** |
| **Pricing / free tier**                       | Free $0 / **20,000 tool calls per month**; $29 / 200k; $229 / 2M. Metered on **tool calls**, not accounts or seats. ⚠️ **The pricing page states rates change on August 15th, 2026** ([composio.dev/pricing](https://composio.dev/pricing)). Do not hardcode tier claims in UI copy.                                                                                                                                                                                                                                                                                                                                                 |
| **Platform model**                            | Confirmed: one project API key + a caller-chosen **`user_id`** (renamed from `entity_id`, [migration](https://docs.composio.dev/docs/migration)). _"Authentication is always per user… Composio stores and refreshes those credentials against that userID"_ ([auth](https://docs.composio.dev/docs/authentication)). Auth configs (`ac_…`) are per-toolkit blueprints shared across users; connected accounts are per-`user_id` grants.                                                                                                                                                                                             |
| **⚠️ The fact that kills "invisible engine"** | Composio's own docs: _"Users will see **'Composio wants to access your account'** during OAuth"_ and _"In production, users should see your app name, not 'Composio.'"_ Managed apps also **share OAuth quota across all users** and enforce a **15-minute minimum polling interval**. Composio explicitly recommends BYO OAuth client for production ([custom-app-vs-managed-app](https://docs.composio.dev/docs/custom-app-vs-managed-app)).                                                                                                                                                                                       |
| **Terms**                                     | Grants a license for "personal and commercial purposes" but excludes "any resale or commercial use of the platform or its contents" ([composio.dev/terms](https://composio.dev/terms)). Embedding a key in distributed client software and provisioning for third parties is **not addressed either way — not documented.** The `user_id` pattern is clearly the intended shape, so it is likely sanctioned, but that is inference. A DorkOS-held shared key needs written confirmation, not a ToS reading.                                                                                                                          |
| **Self-host**                                 | SDK/CLI are MIT; the credential vault and execution backend are **closed source**; self-hosting is Enterprise/sales-gated ([issue 291](https://github.com/ComposioHQ/composio/issues/291), [enterprise](https://composio.dev/enterprise)). Rube + Tool Router are the official MCP surfaces and do support per-user auth.                                                                                                                                                                                                                                                                                                            |

### Nango

| Question                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Programmatic provisioning** | **No.** No signup/provisioning API. The Connect Session token (`POST /connect/sessions`) looks like the answer and is not — it **requires an existing secret key** with `environment:connect_sessions:write` scope and mints a 30-minute browser-scoped token ([reference](https://nango.dev/docs/reference/api/connect/sessions/create)). A secret-scoping mechanism, not account provisioning.                                                                                                                                                                                                                    |
| **Pricing / free tier**       | Free = **10 connections**, 100k proxy requests. Starter from $50/mo (20 connections, then **$1/connection/month**). Growth from $500/mo (100 included) ([nango.dev/pricing](https://nango.dev/pricing/)). A "connection" = one authorized user account, prorated.                                                                                                                                                                                                                                                                                                                                                   |
| **License**                   | **Elastic License 2.0** — source-available, _not_ OSI open source ([LICENSE](https://github.com/NangoHQ/nango/blob/master/LICENSE)). Permits self-hosting and bundling with terms passed along; forbids providing it "to third parties as a hosted or managed service." Bundling for a self-hosted product is consistent with ELv2.                                                                                                                                                                                                                                                                                 |
| **⚠️ The self-host trap**     | Free self-hosted Nango is **Auth + Proxy only**. Functions, webhooks, custom auth branding, **and Nango's own MCP server** all require a paid Enterprise self-hosted license ([self-hosting](https://nango.dev/docs/guides/platform/self-hosting)). This is almost certainly why `nango-proxy-mcp.ts` exists in this repo — DorkOS had to build its own Proxy→MCP wrapper because Nango's MCP server is paywalled. State this plainly in the Advanced disclosure.                                                                                                                                                   |
| **Shared OAuth apps**         | Exist for some providers and "work in production too, but we strongly recommend registering your own before going live" — because with Nango's app _"**users authorize Nango instead of your product**"_ ([auth guide](https://nango.dev/docs/guides/auth/auth-guide)). Same branding leak as Composio. For **Google/Gmail**, Nango documents registering **your own Google Cloud project** ([Google](https://docs.nango.dev/integrations/all/google), [Gmail](https://docs.nango.dev/integrations/all/google-mail)); Google independently requires app verification + CASA assessment for restricted Gmail scopes. |

### How comparable products present "connect your account"

- **Claude connectors / Cowork.** In-app OAuth redirect: click connect, "authenticate directly with your Google account," return to Claude ([help](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)). No aggregator, no vendor, no key ever visible.
- **Zapier.** Inline in the Zap editor: "Sign in" / "+ Add connection" opens a tab to the app's own consent screen ([help](https://help.zapier.com/hc/en-us/articles/8496258785421-Connect-your-app-accounts-to-Zapier)). Zapier presents itself as the only party.
- **Raycast.** Two patterns per-extension: OAuth through **Raycast's own PKCE proxy** (`oauth.raycast.com`) so extensions never hold a secret ([OAuth ref](https://developers.raycast.com/api-reference/oauth)), or a per-extension API-key preference field. Raycast is visible as the platform; no third-party aggregator is.
- **The finding that should end the debate:** across this survey, **no consumer- or prosumer-facing product asks a user to bring an aggregator API key.** That pattern exists only in developer/B2B contexts. The nearest analog is self-hosted n8n's BYO-provider-OAuth-app requirement, documented and widely complained about as friction. The current page does something no comparable product does.

### Vendor remote-MCP matrix (first-hand HTTP probes + primary docs)

`DCR-adv` = auth-server metadata advertises an RFC 7591 `registration_endpoint`. `DCR-proven` = a live anonymous registration POST with a `http://localhost:4242/...` redirect and `application_type:"native"` was **accepted**.

| Vendor                       | Endpoint                                                                                                                              | Probe                                       | DCR-adv     | DCR-proven            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Linear**                   | `mcp.linear.app/mcp`                                                                                                                  | 401 + RFC 9728 pointer                      | yes         | ✅ `client_id` issued | GA. Read-only variant at `/mcp/readonly`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Notion**                   | `mcp.notion.com/mcp`                                                                                                                  | 401 + pointer                               | yes         | ✅ `client_id` issued | Hosted server production; broader Notion Developer Platform is alpha — don't conflate.                                                                                                                                                                                                                                                                                                                                                                  |
| **Stripe**                   | `mcp.stripe.com/`                                                                                                                     | 401                                         | yes         | ✅ `client_id` issued | Reg endpoint `access.stripe.com/mcp/oauth2/register`. Treasury tools public-preview.                                                                                                                                                                                                                                                                                                                                                                    |
| **Vercel**                   | `mcp.vercel.com/`                                                                                                                     | 401                                         | yes         | ✅ `client_id` issued | Docs claim a **client allowlist** (Claude/Cursor/VS Code); registration nonetheless succeeded, so enforcement is elsewhere (likely authorize-time).                                                                                                                                                                                                                                                                                                     |
| **Sentry**                   | `mcp.sentry.dev/mcp`                                                                                                                  | 401 + pointer                               | yes         | untested              | ⚠️ **60 req / 60 s per authenticated user**, shared across sessions — tight for agent fan-out.                                                                                                                                                                                                                                                                                                                                                          |
| **Atlassian**                | `mcp.atlassian.com/v1/sse`, `/v1/mcp/authv2`                                                                                          | 401                                         | yes         | untested              | Since 2026-05-27 implements RFC 7591 + 8414 + 9728 so "any standards-compliant client can connect automatically."                                                                                                                                                                                                                                                                                                                                       |
| **Asana**                    | `mcp.asana.com/sse`, `/v2/mcp`                                                                                                        | 401                                         | yes         | untested              | Docs say **DCR not supported**, pre-registered app + redirect-URI allowlist. Metadata/doc conflict — verify before shipping.                                                                                                                                                                                                                                                                                                                            |
| **Cloudflare**               | `mcp.cloudflare.com/mcp`                                                                                                              | 401                                         | yes         | untested              | Built on `workers-oauth-provider`, which guarantees DCR support.                                                                                                                                                                                                                                                                                                                                                                                        |
| **Intercom**                 | `mcp.intercom.com/sse`                                                                                                                | 401                                         | yes         | untested              | **US-hosted workspaces only.**                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Canva**                    | `mcp.canva.com/mcp`                                                                                                                   | 401                                         | yes         | untested              | **Beta, waitlist required.** Canva's docs push **CIMD** as "the recommended authentication method for MCP."                                                                                                                                                                                                                                                                                                                                             |
| **PayPal**                   | `mcp.paypal.com/mcp`                                                                                                                  | 401                                         | yes         | untested              | Pre-registered dashboard client implied.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Webflow**                  | `mcp.webflow.com/sse`                                                                                                                 | 401                                         | yes         | untested              | Auto-installs a non-public "MCP Bridge App" during authorization.                                                                                                                                                                                                                                                                                                                                                                                       |
| **Figma**                    | `mcp.figma.com/mcp`                                                                                                                   | 405                                         | yes         | untested              | OAuth only, no PATs. **Reported** to 403 DCR outside a partner allowlist (community forum, not official).                                                                                                                                                                                                                                                                                                                                               |
| **Supabase / Neon**          | `mcp.supabase.com/mcp`, `mcp.neon.tech/mcp`                                                                                           | —                                           | yes         | untested              | Both document DCR as the **default**; no PAT needed.                                                                                                                                                                                                                                                                                                                                                                                                    |
| **GitHub**                   | `api.githubcopilot.com/mcp/`                                                                                                          | 401 + PRM pointer                           | n/a at host | no                    | GA since 2025-09-04. OAuth 2.1 + PKCE **or** PAT. **Reported** not to support DCR.                                                                                                                                                                                                                                                                                                                                                                      |
| **HubSpot**                  | `mcp.hubspot.com/anthropic`                                                                                                           | 401                                         | **no**      | no                    | GA since April 2026. Manual "MCP Auth App" in the developer dashboard.                                                                                                                                                                                                                                                                                                                                                                                  |
| **Slack**                    | `mcp.slack.com/mcp`                                                                                                                   | 401                                         | **no**      | **prohibited**        | ⚠️ See below.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **🔴 Google**                | `gmailmcp.googleapis.com/mcp/v1`, `calendarmcp`, `drivemcp`, `docsmcp`, `sheetsmcp`, `chatmcp`, `slidesmcp`, `people` — all `/mcp/v1` | **405 on all six probed** (live, POST-only) | none        | n/a                   | **Google DOES run official Workspace remote MCP servers.** No `www-authenticate`, no discovery metadata — because the model is **bring-your-own OAuth client**: _"configure a custom connector with an OAuth client ID and secret."_ Requires a Google Cloud project, consent-screen verification, and **CASA assessment for restricted Gmail scopes**. ([configure-mcp-servers](https://developers.google.com/workspace/guides/configure-mcp-servers)) |
| **Microsoft**                | Graph MCP (enterprise/identity), Azure DevOps (preview)                                                                               | —                                           | —           | —                     | Teams/M365 docs are mostly the _inverse_ model (register your server as an Agent Connector). No consumer-content server.                                                                                                                                                                                                                                                                                                                                |
| **Apple, Discord, Telegram** | —                                                                                                                                     | —                                           | —           | —                     | No official vendor-hosted MCP server. Community only.                                                                                                                                                                                                                                                                                                                                                                                                   |

**Boundary on the DCR result:** registration is **proven** for 4 vendors. **End-to-end authorization is unproven for all of them** — a consent-time allowlist cannot be tested without a real user grant. Vercel, Square, and Figma all document client allowlists. Any catalog sizing must follow a spike that carries **one** vendor from registration through a working tool call.

### 🔴 Slack is prohibited, not merely inconvenient

> _"Only directory-published apps or internal apps may use MCP. **Unlisted apps are prohibited from using MCP.**"_ — [docs.slack.dev/ai/slack-mcp-server](https://docs.slack.dev/ai/slack-mcp-server)

Plus: Streamable HTTP only (no SSE), **confidential** OAuth requiring a `client_secret` a local desktop app cannot hold safely, no DCR, and admin approval via Slack's app-approval workflow. **Drop Slack from any direct catalog.** DorkOS already has the purpose-built Relay Slack adapter, and `recommendConnector` already routes Slack there at rank 0 (`routing.ts:42`). That was correct and remains the answer.

Slack is also the sharpest real-world precedent that a vendor _will_ say no in writing to being shipped as a preconfigured default.

### MCP authorization: the current spec and the CIMD/DCR ladder

The current MCP revision is **2026-07-28** ([versioning](https://modelcontextprotocol.io/specification/versioning)) — finalized one day before this review. Normative requirements from [basic/authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and [client-registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration):

- **OAuth 2.1 — MUST** for authorization servers.
- **PKCE — MUST**, `S256` required when technically capable; if `code_challenge_methods_supported` is absent, the client **MUST refuse to proceed**.
- **🔴 DCR (RFC 7591) is DEPRECATED** — normative level **MAY**: _"Dynamic Client Registration is deprecated. New implementations should use Client ID Metadata Documents instead… retained for backwards compatibility."_
- **✅ Client ID Metadata Documents (CIMD) — SHOULD** for clients and servers. Host a JSON metadata doc at an HTTPS URL and use that URL _as_ the `client_id`; the auth server fetches and validates on demand. Same "no prior relationship" property as DCR, no registration round-trip, portable across authorization servers.
- **Registration priority ladder (implement in this order):** (1) pre-registered credentials → (2) CIMD if the server advertises `client_id_metadata_document_supported` → (3) DCR if a `registration_endpoint` exists → (4) prompt the user.
- **Protected Resource Metadata (RFC 9728) — MUST** for servers and for client AS-discovery.
- **Resource Indicators (RFC 8707) — MUST** — every authorize/token request carries `resource` bound to the canonical server URI (confused-deputy defense).
- **RFC 9207 issuer validation — MUST**, new this revision: record the expected `issuer`, validate on callback (mix-up defense).
- **Loopback redirects are spec-blessed:** _"All redirect URIs MUST be either `localhost` or use HTTPS."_ The CIMD example in the spec itself uses `http://127.0.0.1:3000/callback`.
- **🔴 `application_type: "native"` — MUST** (SEP-837). Omitting it defaults to `"web"` under OIDC, **which rejects localhost redirect URIs**. This requirement exists specifically to fix loopback for desktop/CLI clients.
- **Caveat to pre-empt in our copy:** the spec directs authorization servers to _"display additional warnings for `localhost`-only redirect URIs"_ and to _"clearly display the redirect URI hostname."_ Expect consent screens to look slightly scarier for a local app.

No canonical registry of DCR- or CIMD-supporting servers exists; `registry.modelcontextprotocol.io` catalogs server existence, not auth capability. Support must be verified per vendor by hand.

### Legal posture (Linear, Notion, GitHub, Sentry, Atlassian)

**Unresolved, not cleared.** No explicit permission and no explicit prohibition was found for shipping these vendors' MCP endpoint URLs as preconfigured defaults in a third-party product. Nearest applicable language:

- **Linear** ([linear.app/terms](https://linear.app/terms)): §2.2(c) bars "licens[ing], sublicens[ing], sell[ing], resell[ing]… or otherwise mak[ing] the Service available to any third party"; §2.2(d) bars removing "copyright, trademark or other proprietary notices, legends or Linear branding"; §2.3 lets Linear "set and enforce limits on Customer's use of the API" at its sole discretion. Reads more as anti-reselling than anti-integration — but that is inference, not clearance.
- **Notion**: separate Developers Terms; Marketplace listing requires a security/privacy review and a trademark license grant. **Full current Developer Terms text was not accessible** — treat clause-level claims as unverified.
- **GitHub**: general Acceptable Use Policies; trademark use requires prior written permission per the Logos and Usage Policy. Standard OAuth-app rate limits (5,000 req/hr authenticated). No MCP-specific distribution clause found.
- **Sentry**: no MCP-specific legal clause located. The binding constraint is operational — 60 req/60 s per user.
- **Atlassian**: Marketplace Developer Terms, App Approval Guidelines, and Brand Guidelines are strict but govern _apps listed on the Marketplace_, a different surface from a third party _pointing at_ `mcp.atlassian.com`. Could not confirm the two surfaces are unified.

**Bottom line:** the question sits in a genuine gap in current public terms. General anti-redistribution and trademark clauses are the closest applicable language. This is a **founder + counsel decision**, not a design call.

---

## (c) Point-by-point critique of the orchestrator's nine answers

**1. Catalog always visible — AGREE, and it is now unavoidable.**
The empty grid is not a cosmetic failure; it is the page's default and permanent state for anyone without a key. But the framing treats the catalog as a _marketing_ device ("recognizable logos pre-setup") that still funnels to setup. The MCP findings change its nature: for roughly a dozen services the catalog is not a teaser for setup — it _is_ the working product. Ship it because it's real, not because it looks populated.

**2. Composio/Nango as invisible "connection engines" — DISAGREE, hardest of anything here.**
You cannot hide Composio, and trying is worse than not trying. Composio's own docs: _"Users will see 'Composio wants to access your account' during OAuth."_ Nango's: _"users authorize Nango instead of your product."_ So the designed flow is: DorkOS never mentions Composio → user clicks Connect Gmail → **Google's consent screen names a company they have never heard of and asks for their mailbox.** For Priya that is a red flag. For Lil it is indistinguishable from a phishing page. You will have manufactured the exact suspicion custody disclosure exists to prevent, at the highest-stakes moment in the product, inside a brand whose voice includes an unprompted honesty note about what leaves the machine (`brand-foundation.md:306`).

Demoting the _setup card_ off the top level: agreed. Concealing the _name of the party that will appear on the consent screen_: no. Name it one beat **before** the user sees it: "The sign-in page will say Composio — that's the service DorkOS uses to hold this connection."

**3. Four disclosure layers — AGREE on shape, EXTEND L1.**
L1 must carry one more thing: **the custody class per tile**, not deferred to L3. Once the catalog mixes direct tiles (token on your disk) with engine tiles (token in Composio's vault), custody stops being a detail and becomes the primary difference between two visually identical tiles. Hiding it until L3 makes the tiles dishonestly uniform.

**4/5. The "moment" and try-it-now — FEASIBLE, verified. Not hand-waving.**
Three primitives exist:

- `/session?prompt=…` is a real search param, documented as seeding a fresh session's composer, "consumed once on mount" (`router.tsx:57-80`).
- `POST /api/sessions/:id/connectors/:accountId` **404s only on unknown account — it never validates the session exists** (`routes/session-connectors.ts:47-51`), so attaching to a client-minted speculative UUID works.
- The session loader already mints speculative UUIDs and forwards `prompt` on the fresh-session branch.

So: mint UUID → attach → navigate with `?prompt=`. Buildable, small.

**But** the DorkBot `recommendForRoles` piece does not exist. What ships is `recommendConnector` (`services/connectors/routing.ts`), which routes _how to connect a service_ — nothing to do with roles or suggested first actions. Do not enter a brief counting on shipped role-aware suggestion.

**And cut the materialize animation** — on the product's own grounds, not just Calm Tech. `10-delight-and-hooks.md`: _"delight is the last coat of paint on each surface, never a substitute for the hardening order. A party hat on an agent whose transcript vanishes on restart is the wrong kind of memorable."_ The account row you want to animate would materialize beside a green "Ready" badge that means "we have a string," on a page that told the founder to add a key she already added. Animating that is the party hat. (The delight doc's anti-list also bars "confetti storms" and anything that "fires during an incident.")

**6. "23 tools" — DISAGREE on honesty and on feasibility.**
Feasibility: `ConnectorToolkitSchema` (`packages/shared/src/connector-provider.ts:76-85`) has `slug`, `displayName`, `authKind`, `maxAccountsPerUser`. **No tool count, no description, no logo, no category.** The number requires a schema change plus a new per-toolkit Composio fetch — and every field in that client is marked _"live-unverified assumption"_ in its own module doc. Honesty: that API currently returns 401, and the swallow-to-`[]` path means a tool count will confidently render `0` or vanish. Quantifying capability from an unverified upstream, in a repo with a formal demo-claim gate, is the wrong number to reach for.

Better and honest: name what the user will be able to _say_. "Read and send mail, search your inbox, manage drafts" beats "23 tools" for every persona, needs no upstream call, and cannot be wrong. **Best available option:** adopt Claude's directory vocabulary — **Read-only / Read & write / Interactive** — which is the fact users actually want before granting mailbox access, is cheap to encode, and is honest.

**7. S-tier polish — AGREE on two, DISAGREE on two.**

- _Real brand marks:_ yes, and you start near zero — `@dorkos/icons` has no Gmail, Notion, Linear, or GitHub mark. Real work, with a trademark question attached (see founder decisions).
- _Custody as a designed trust object:_ strongest idea in the list. Yes.
- _"Hero promise header":_ no. That is the consumer-app instinct the brand explicitly rejects — _"the product feels like a control panel, not a consumer app."_ The existing header is already correct and plain. A hero on a page whose real problem is that it does not work is decoration over a fault.
- _"Kill the three-stacked-cards layout":_ agree, but that names the symptom. The problem is not three stacked sections; it is that two are empty and the third is plumbing. Remove Providers from the top level and Accounts merges naturally into the catalog as connected-state tiles. Then there is one section and the layout question dissolves.

**8. The FTUE sequence — right shape, WRONG entry point, and one unkeepable promise.**
"Land on /connections → click Gmail → 60s guided engine setup" assumes users arrive at this page. Nothing routes them there: it is the sixth sidebar item, and the Dashboard's DISCOVER cards advertise _Slack & Telegram notifications_, a different feature that owns the word "connect."

The closing beat — _"attach to new sessions by default?"_ — is a promise the backend cannot keep. `session-exposure.ts:36-44`: attachments are **in memory, process-scoped**, and _"after a server restart a session's attachments are gone and the user re-attaches."_ Offering a persistent default on top of non-durable state breaks silently on the next restart, with the agent simply lacking the tool. **Do not ship that question until attachments persist.**

**9. Auto-provisioning / DorkOS-held platform key — DISAGREE, and the corrected facts make the case stronger.**
Technically it is the org-key path: DorkOS holds an org key server-side and either mints per-user projects via `project/new` or scopes everyone under one key by `user_id`. It works. The costs:

- **Brand.** `brand-foundation.md:302`: _"DorkOS is not a model aggregator. Not a chat widget. **Not a cloud platform.** It's an autonomous agent operating system you run on your machine, configure, and control."_ The revenue model is explicit that "the Cloud is a coordination layer, **not compute**." A DorkOS-held key makes DorkOS the party that arranged custody of a user's Gmail token into a third-party vault. That is not coordination — it is being a credential intermediary, the heaviest promise in the product, and off-thesis.
- **Personas.** Priya reads source before adopting; she will find the shared key and ask whose traffic rides it. Lil exists to keep privacy defaults honest, and a shared vendor key is the thing she avoids. Kai's objection is narrower and sharper: per Composio's own docs, managed apps share OAuth quota and enforce a 15-minute minimum poll interval, so behavior degrades as user count grows.
- **Cost.** Metered on tool calls. Agents are the highest-tool-call-volume client imaginable; 20,000 free calls is one enthusiastic week for one user. Unbounded per-user variable cost with no attribution.
- **Legal.** The ToS bans "resale or commercial use of the platform or its contents" and is silent on embedding a key for third parties. That is an unaddressed question needing a signature, not a green light.
- **And it is now almost entirely unnecessary.** Direct connection covers roughly a dozen services with a **better** custody story than a platform key could ever have. It was justified mainly by a Google gap that turns out to have a better answer: **Google runs its own Workspace MCP servers**, so a DorkOS-registered Google OAuth client reaches Gmail directly — DorkOS's name on the consent screen (the correct name) and the token on the user's own disk (the correct place). The honest cost is a Google Cloud project, consent-screen verification, and CASA assessment for restricted scopes: expensive and slow, but a one-time founder investment rather than a permanent brand contradiction.

### What the nine answers missed entirely

Ranked by how much each changes the design:

1. **The page is currently a dead end with a false green light** (§a.1). Everything in the nine answers is polish on a broken flow.
2. **`raw-mcp.ts` reports success without authenticating anything.** `startConnect` returns `server.connection.url` — the MCP endpoint itself — as the `authorizeUrl`, and `ConnectDialog` renders it as `<a href={authorizeUrl} target="_blank">Open the sign-in page</a>`. Verified: a browser GET to those URLs returns `{"error":"invalid_token","error_description":"Missing or invalid access token"}`. The user clicks "Open the sign-in page," gets raw JSON in a tab, returns, and `pollConnect` — which sets `status:'connected'` **unconditionally, with no auth check at all** (`raw-mcp.ts:131-149`) — says "Linear is connected." **A fabricated success**, in the code the catalog plan proposes to make the front door.
3. **The `warnings[]` hole** — an entire honesty subsystem defeated by the throw-free provider contract, with a source comment asserting the opposite.
4. **Attachments die on restart** — kills answer 8's closing beat.
5. **Composio's name is unhideable at consent** — kills answer 2.
6. **Composio pricing changes Aug 15** — any tier or quota claim written this week is stale in two weeks.
7. **Free self-hosted Nango has no MCP server** (Enterprise-gated) — the "Advanced: self-host" path is thinner than it sounds, and this is why `nango-proxy-mcp.ts` exists.
8. **`rawMcpServers` is boot-read-only** — _"config edits take effect on the next server start"_ — and its schema carries no display metadata. A user-editable catalog needs live reload; a curated catalog must live in code.
9. **The in-chat path is the actual primary journey and got no design.** Seven connector capabilities ship (`connector-capabilities.ts`), `connector.attach_account` is correctly gated `destructive`-tier, and `start_connect` returns markdown with the sign-in URL and verbatim custody line. "DorkBot, connect my Gmail" needs zero navigation. The page is the _management_ surface; chat is the _entry_ surface.
10. **Sidebar placement and the "connect" word collision** (§a smaller findings).
11. **`SessionConnectorsGroup` returns `null` when nothing is connected** — correct Calm Tech, zero discovery, at the exact moment of felt need.
12. **The breadcrumb bug.**
13. **Mobile** — three stacked dead sections, only control below the fold.
14. **Most users will have zero providers forever unless defaults change.** The nine answers treat the empty catalog as a presentation problem. It is a defaults problem, and direct connection is the fix.

---

## (d) Prioritized brief

Ranked by impact ÷ effort. **[FOUNDER]** marks items needing a product decision first.

### P0 — Make provider status tell the truth

**What.** Three changes. (i) The provider status DTO gains liveness distinct from configured-ness — `reachable: boolean` plus `lastError?: string` — so the badge can read **"Key rejected"** instead of "Ready." (ii) `listToolkits`/`listAccounts` stop laundering transport failures into `[]`: either rethrow so `_aggregate` records the warning, or return a discriminated `{ok:false, error}` the registry maps to a warning — and delete the false comment at `composio.ts:144-146`. (iii) The Services empty state branches: _no provider configured_ (offer setup) vs _provider configured but returned nothing_ (surface the error verbatim, offer re-enter key).
**Why.** The surface currently answers a rejected credential with a green badge and an empty state that blames the user for not adding the key they just added. This is happening on the founder's own machine. No amount of catalog design outranks fixing a surface that lies about custody.
**Files.** `providers/composio.ts`, `providers/nango.ts`, `registry.ts`, `bootstrap.ts:_statusFor`, `ProviderSetupCard.tsx`, `ServiceGrid.tsx`. Add a regression test: a 401ing provider **must** produce a non-empty `warnings[]`.
**Impact/effort.** Highest impact / small effort. Do this first.
**Founder decision.** None.

### P0b — Stop `raw-mcp.ts` fabricating success

**What.** `pollConnect` must not return `connected` without evidence of authentication. Until P1 lands, return `failed` with an honest message rather than inventing an account.
**Why.** It currently mints an "active" account after the user is shown a raw JSON error page. A default catalog built on this ships a page full of fake connections.
**Impact/effort.** Correctness gate / small effort. Non-negotiable before any catalog work.
**Founder decision.** None.

### P1 — Real OAuth for direct connections, plus a curated built-in catalog

**What.** In `raw-mcp.ts`, implement the current MCP spec's authorization flow:

1. Discover PRM via the 401's `resource_metadata` pointer → fetch AS metadata (RFC 8414 / OIDC discovery).
2. Obtain a client identity by the **spec's priority ladder**: pre-registered credentials → **CIMD** (host a metadata doc, use its URL as `client_id`) → **DCR** as the compatibility rung → prompt.
3. Register/declare with **`application_type: "native"`** (MUST — without it, OIDC servers reject localhost) and redirect `http://localhost:<DORKOS_PORT>/api/connectors/mcp/callback`.
4. Build a **PKCE S256** authorize URL including the **RFC 8707 `resource`** parameter, and **return that as `authorizeUrl`** — a real sign-in page, not a 401 blob.
5. New callback route validates **RFC 9207 `issuer`**, exchanges `code` + verifier at the token endpoint, stores the token via the existing `CredentialProvider` (`~/.dork/`).
6. `pollConnect` returns `connected` only when a token exists.
7. `toolServerForAccount` returns `{transport:'http', url, headers:{Authorization:'Bearer …'}}`. **`headers` already plumbs through to the SDK unchanged** (`claude-code/mcp-server-config.ts:25-38`) — no new seam needed.
8. Refresh-token handling; a 401 at tool time maps to the existing `expired` null-branch.

**Catalog.** Ship as a **built-in constant in code**, not `connectors.rawMcpServers` (boot-read-only, no display metadata). Keep `rawMcpServers` as the user-extension escape hatch. **Gate the catalog behind a spike** that carries one vendor (Linear) from registration through a real user grant to a working tool call — registration success does not prove authorize-time acceptance. Then size the list from: Linear, Notion, Stripe, Vercel, Sentry, Atlassian, Cloudflare, Supabase, Neon, Canva, Figma, Webflow, Intercom. **Exclude Slack** (prohibited). Treat Asana as verify-first (docs and metadata conflict). Handle per-vendor rate limits (Sentry: 60 req/60 s per user) as an honest "slow down" state.

**Custody.** This creates a fourth custody class, and it is the best one in the product: **"Direct — you sign in to Linear, and the key stays on your machine. DorkOS holds it; nothing leaves."**
**Why.** Makes the page non-empty for every user forever, removes the aggregator from the path for the most recognizable services, and delivers the local-first brand promise literally in the surface where it is hardest to earn.
**Impact/effort.** Transformative / large.
**Founder decision.** **[FOUNDER] #1, #3** (below).

### P2 — Invert the page around the catalog

**What.** One primary section: a catalog where each tile carries service name, real brand mark, a concrete capability line, and a **custody chip** (`Direct` / `via engine`) plus a **capability facet** (`Read-only` / `Read & write` / `Interactive`, adopting Claude's directory vocabulary). Connected accounts render as connected-state tiles in place, not a separate section. `Providers` leaves the top level entirely: engine setup appears inside the first long-tail connect, plus a quiet "Advanced" disclosure holding Nango self-host, raw-MCP entry, and key management — mirroring Claude's two-tier "directory + custom connector (not verified)" split. Fix the breadcrumb. Verify mobile: one actionable column, no dead space above it.
**Why.** Fixes the inverted hierarchy, the impossible first decision, and the mobile fold in one move. The capability facet answers "show the power" honestly, without an unverified tool count.
**Impact/effort.** High / medium.
**Founder decision.** **[FOUNDER] #1** (trademark, for the marks).

### P3 — Rewrite engine-setup and custody copy honestly

**What.** Engine setup must state, before the user clicks anything: the sign-in page will show **Composio's** name; that is the service holding this connection; here is why; here is the alternative. Fix Nango's tense — it currently asserts a Nango server the user does not have. Do **not** state Composio quota tiers in UI copy (pricing changes Aug 15). Note in the Advanced disclosure that free self-hosted Nango has no MCP server. Route everything through `writing-for-humans`.
**Why.** Composio's name is unhideable at consent. Naming it one beat early converts a phishing-shaped surprise into a trust signal.
**Impact/effort.** High trust impact / small effort.
**Founder decision.** **[FOUNDER] #5** (tone), **#7** (pricing claims).

### P4 — Make chat the front door

**What.** Give DorkBot a first-class rendering for "connect my Gmail" (the seven capabilities already ship). Make `SessionConnectorsGroup` speak when nothing is connected **and** the session's agent just tried to reach a service it lacks — the teachable moment, currently silent. Consider a Dashboard DISCOVER card for account connections, worded distinctly from the Slack/Telegram notification card to kill the verb collision.
**Why.** The in-chat path needs zero navigation and is the real primary journey; the page is the management surface. Discovery is the only thing missing.
**Impact/effort.** High / medium, mostly copy.
**Founder decision.** None.

### P5 — Persist session attachments, or stop promising them

**What.** The spec defers attachment durability to "the picker-UI phase"; that phase has arrived. Until attachments survive a restart, drop "attach to new sessions by default" entirely.
**Why.** A silent post-restart capability loss is worse than an explicit attach step.
**Impact/effort.** Medium / medium.
**Founder decision.** None.

### P6 — Try-it-now, sequenced last

**What.** Mint UUID → `POST /api/sessions/:id/connectors/:accountId` → `navigate({to:'/session', search:{session, prompt}})`. All three primitives verified present. One chip, one honest verb, no animation.
**Why.** Closes the loop from connect to visible value. Genuinely cheap once the surface is truthful.
**Impact/effort.** Medium / small (after P0–P2).
**Founder decision.** **[FOUNDER] #6** (prompt source — there is no shipped role-aware recommender; a small curated per-service map is the honest v1).

---

## (e) The whole-game insight

**Every service worth connecting is reachable directly, and the token can live on the user's own machine. The aggregator is a shortcut past OAuth-client registration — not a requirement, and not a foundation.**

Direct connection is the front door: for roughly a dozen services via CIMD/DCR with zero setup, and for Google via a DorkOS-registered OAuth client that puts our name on the consent screen where it belongs. In both cases DorkOS holds the token locally — the local-first brand promise delivered literally, in the surface where it is hardest to earn. Composio stays as the honestly-labeled engine for the long tail and as the way to skip Google verification: named out loud, one beat before Google's consent screen names it for you.

So the strategic move is one sentence: **stop treating the aggregator as the foundation and the direct connection as the fallback. Invert it.**

And the precondition, before any of it: **the page currently answers a rejected credential with a green "Ready" badge and an empty state blaming the user for not adding the key they just added.** No amount of catalog design, animation, or hero copy outranks fixing a surface that lies about custody — in the one place where lying about custody is the entire risk.

---

## (f) Open founder decisions

1. **Ship vendor names, endpoint URLs, and brand marks as preconfigured defaults?** Legally **unresolved** — no explicit permission or prohibition from Linear/Notion/GitHub/Sentry/Atlassian; the nearest language is anti-redistribution and trademark. Slack proves at least one vendor says no in writing. Needs counsel, not a design read. **Blocks P1 catalog scope and P2 marks.**
2. **Register DorkOS's own Google Cloud OAuth client for the Workspace MCP servers?** Cost: a GCP project, consent-screen verification, and **CASA assessment for restricted Gmail scopes**. Buys direct Gmail/Calendar/Drive with DorkOS's name on the consent screen and the token on the user's disk. The alternative is routing Google through Composio and disclosing it. **Blocks the Gmail story either way.**
3. **Name the fourth custody class.** Recommended: **"Direct — the key stays on your machine."** It is the strongest custody sentence available and the one the brand has been claiming all along. **Blocks P1 copy.**
4. **Kill or pursue the DorkOS-held platform key.** Recommendation: **kill it.** Off-thesis for "not a cloud platform," unbounded per-user tool-call cost, shared OAuth quota that degrades with growth, unresolved ToS, adverse Priya/Lil reactions — and now largely unnecessary, since direct connection covers the catalog and Google has its own endpoints. Needs an explicit decision so it stops reappearing.
5. **Tone for naming Composio at consent.** How forward should the disclosure be? Recommendation: plainly forward — "the sign-in page will say Composio" — one beat before the user sees it.
6. **Source of the try-it-now suggested prompts.** No role-aware recommender ships (`recommendForRoles` does not exist). Recommendation: a small curated per-service map as v1.
7. **State Composio pricing/quota in UI copy at all?** Rates change **Aug 15, 2026**. Recommendation: no numbers in UI; link out.
8. **Which vendors enter the v1 catalog**, pending the P1 authorize-time spike. Registration is proven for Linear, Notion, Stripe, Vercel; end-to-end authorization is unproven for all. Slack is excluded (prohibited); Asana's docs and metadata conflict; Canva is waitlisted; Intercom is US-only; Figma reportedly allowlists.
