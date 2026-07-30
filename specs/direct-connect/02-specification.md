---
slug: direct-connect
id: 260729-234947
created: 2026-07-29
status: specified
---

# Direct connect — OAuth 2.1 for remote MCP, multi-account, key on your machine

**Status:** Draft (frozen for DECOMPOSE)
**Author:** spec-direct (SPECIFY stage)
**Date:** 2026-07-29
**Input:** `/connections` design critique + fact-check (2026-07-29) §(d) P0b/P1/P5, §(f) 1–4. Ideation: `specs/direct-connect/01-ideation.md`. Quality bar: `specs/connector-gateway`, `specs/connector-completion`.

## Overview

DorkOS gains a **direct** connector: the user signs in to a service's own remote MCP server, and DorkOS holds the resulting OAuth token on the user's own machine, encrypted. This replaces the shipped `raw-mcp` adapter, which opens a raw JSON error page as its "sign-in page" and then reports `connected` with no authentication whatsoever (`providers/raw-mcp.ts:131-149`).

Four things ship together because none is honest without the others: (1) the 2026-07-28 MCP authorization ladder, implemented over `@modelcontextprotocol/sdk@1.29.0`'s `auth()` with the three MUSTs it misses closed by us; (2) multi-account — two Linears, two Notions, each its own token identity and its own named tool server; (3) `connected` gated on a real authenticated MCP `initialize`; (4) a fourth custody class, `direct`, whose disclosure sentence is true.

Two ship gates. The **mechanism** (a user adds a server, DorkOS authenticates it properly) needs no legal clearance and ships first. The **preconfigured vendor catalog** sits behind a config flag defaulting off until counsel clears founder decision 1.

## Background / Problem Statement

Every service worth connecting is reachable directly and the token can live on the user's own machine (critique §(e)). Registration is live-proven against Linear, Notion, Stripe, and Vercel with `application_type: "native"` and a `http://localhost:…` redirect; **authorize-time acceptance is unproven for all of them**, because a consent-time client allowlist cannot be tested without a real grant. Hence a one-vendor spike gates catalog sizing.

Google is not a gap: it runs `<product>mcp.googleapis.com/mcp/v1` servers for Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, and People, on a bring-your-own-OAuth-client model. A DorkOS-registered Google client puts **our** name on the consent screen and the token on the user's disk — the correct name in the correct place.

**Why the SDK, not a hand-rolled client.** `client/auth.js` in 1.29.0 already does PRM discovery (RFC 9728), AS discovery (RFC 8414/OIDC), the exact registration priority ladder (`auth.js:226-258`), PKCE S256, RFC 8707 resource indicators (`selectResourceURL`), token exchange, and refresh. Ours to add: `application_type: "native"`, RFC 9207 issuer validation, and refusing a server that does not advertise `code_challenge_methods_supported`.

## Decisions (LOCKED — do not relitigate)

1. **Direct connection is the front door.** The managed vault remains the honestly-labeled engine for the long tail.
2. **The DorkOS-held platform key is killed** (founder decision 4). No shared vendor key, ever.
3. **Fourth custody class is `direct`**, disclosed as _"Direct — the key stays on your machine"_ (founder decision 3).
4. **DorkOS registers its own Google Cloud OAuth client** (founder decision 2), with a BYO-client Advanced hatch (rclone's pattern).
5. **One provider, not two.** `type: 'mcp'` keeps its registry key, route segment, and DB rows; static custody becomes `direct`; `ConnectedAccount.custody` carries `external` per-account for a server that needs no token.
6. **Catalog shipping is gated on counsel review.** Both modes must work: user-adds-server (ungated) and preconfigured catalog (flag, default off).
7. **Slack is excluded.** Prohibited in writing for unlisted apps; the Relay adapter already ranks first.
8. **No vendor is claimed to work** until a real grant has been carried against it (demo-claim gate).

## Decisions resolved in SPECIFY

- **Callback port strategy. RESOLVED: a dedicated loopback listener on a fixed 4-port ladder** (`127.0.0.1:4266-4269`, path `/oauth/callback`). The cockpit's own port varies across prod (4242), dev (6242), and worktrees; a hosted CIMD document cannot enumerate that, and redirect-URI exact match needs stability. RFC 8252 §7.3 says an AS _MUST_ allow any port for loopback redirects, but that is unproven against MCP auth servers and CIMD documents are static — so we declare all four and bind one. `127.0.0.1` literal, never `localhost` (RFC 8252 §8.3: `localhost` resolves through DNS and the hosts file).
- **Token storage. RESOLVED: one JSON blob per account in `EncryptedFileCredentialStore`** under `direct-mcp:<accountId>:tokens`, holding `{ access_token, refresh_token?, expires_at?, scope? }`. One atomic write per grant, no partial-refresh window. Client registrations (which may carry a DCR-issued `client_secret`) go to `direct-mcp-client:<serverKey>`. **No secret ever reaches SQLite.**
- **Durable account state. RESOLVED: a new `direct_mcp_accounts` table**, provider-owned, holding refs and metadata only. `connected_accounts` stays the provider-neutral routing cache (ADR-0043 pattern; `codex_threads` / `opencode` are the precedent for runtime-owned side tables).
- **Attachment persistence (critique P5). RESOLVED: a new `session_connector_attachments` table**, lazily rehydrated. Config is wrong for this: session-scoped, unbounded, high-churn. `serverName` persists too — a restart that renumbered a tool server would break the tool names an in-flight session already learned.
- **Duplicate-identity handling. RESOLVED: detect after the grant, refuse honestly, allow override.** A best-effort `identityHint` ladder (below); a match on the same server means `failed` with `duplicate-identity` and a plain sentence naming the browser-profile workaround — never a silent duplicate. `startConnect({ allowDuplicateIdentity: true })` overrides when our hint is wrong.
- **Catalog freshness. RESOLVED: ship-pinned.** A code constant on the release train. Remote-updatable adds a network dependency under a core surface plus a content-signing problem; revisit only if per-entry churn proves faster than releases.

## Goals

- **G1** — The full 2026-07-28 ladder: PRM discovery → pre-registered → CIMD → DCR → prompt the user, with `application_type: "native"`, PKCE S256 mandatory (refuse when unadvertised), RFC 8707 `resource`, RFC 9207 `iss` validation.
- **G2** — Tokens (access + refresh) per **account**, in `EncryptedFileCredentialStore` via `CredentialProvider`; never plaintext, never logged, never in a response.
- **G3** — `supportsMultiAccount: true`. N grants of one service = N accounts, N token identities, N distinctly-named session tool servers.
- **G4** — `pollConnect` returns `connected` only after a verified authenticated MCP `initialize` against the server. Every other outcome is a typed, plainly-worded failure.
- **G5** — Silent token refresh at the exposure seam, single-flight; a dead token degrades to the existing surfaced `expired` warning with a reconnect affordance.
- **G6** — `custody: 'direct'` with true disclosure copy, enforced by the existing `never`-typed exhaustiveness guard.
- **G7** — Google Workspace MCP reachable with the DorkOS-registered client (default) or a BYO client id (Advanced).
- **G8** — Session attachments survive a restart.
- **G9** — A flag-gated built-in catalog with per-entry custody, capability, and hand-filled authorize-time verification status. Slack absent.
- **G10** — Disconnect revokes at the vendor where a `revocation_endpoint` is advertised, and drops live session exposure.

## Non-Goals

- The `/connections` page redesign, catalog tiles, brand marks, try-it-now (critique P2/P4/P6 — a separate surface spec). Here: only real states in the existing `ConnectDialog`.
- The managed provider's throw-free `warnings[]` hole (critique P0) — same layer, separate defect.
- Google consent-screen verification and CASA as _code_. It is founder ops; Appendix A is the checklist.
- Automating a real-vendor grant in CI. Impossible; hand-verified per vendor, recorded per catalog entry.
- Obsidian `DirectTransport` parity beyond read surfaces.

## Technical Dependencies

`@modelcontextprotocol/sdk@1.29.0` (already a direct `apps/server` dep) — `client/auth.js`, `client/index.js`. `EncryptedFileCredentialStore` + `CredentialProvider` (`services/core/credential-provider.ts`). `@dorkos/db` migrations. `apps/site` Next.js route handler for the CIMD document. No new packages.

## Detailed Design

### 1. The direct provider

`providers/raw-mcp.ts` → `providers/direct-mcp.ts`, `RawMcpConnectorProvider` → `DirectMcpConnectorProvider`. `type` stays `'mcp'` (registry key, `:provider` route segment, and `connected_accounts.provider` rows all stay valid — no migration). The config key `connectors.rawMcpServers` also stays: it is the user-extension escape hatch, and renaming a user-facing config key costs a semver `conf` migration for zero user benefit.

```
getCapabilities() → {
  type: 'mcp',
  supportsMultiAccount: true,          // was false
  custody: 'direct',                   // was 'external'
  exposesOverMcp: true,
  features: { oauthLadder: true, catalogEnabled: <flag> },
}
```

Account ids become `mcp:<slug>:<8-hex>` — opaque and multi-account-safe. `maxAccountsPerUser` per toolkit: `undefined` (unbounded) for an OAuth-protected server, `1` for one that needs no auth.

**Legacy rows: adopt, drop, or defer — never blanket-purge.** Legacy `mcp:<slug>` rows in `connected_accounts` are not uniformly fabricated. For a server that needs **no** auth, the old `toolServerForAccount` returned `server.connection` with no bearer, so the account genuinely worked and still would. Deleting it would destroy a working connection. Compounding this, `RawMcpServerConfigSchema` (`config-schema.ts:567-576`) has **no `authKind` field** while the descriptor defaults `authKind ?? 'oauth2'`, so every hand-configured no-auth server is currently mislabeled as OAuth — the declared kind cannot be trusted as the discriminator. Two consequences:

1. **`authKind` is added to `RawMcpServerConfigSchema`** (`ConnectorAuthKindSchema`, default `'oauth2'`) via the `adding-config-fields` skill, so a user can declare a no-auth server truthfully.
2. **Boot reconciles each legacy row against ground truth — an unauthenticated `initialize` probe — not against the declared kind:**

| Probe result                       | Action                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| server no longer configured at all | **drop** (nothing can serve it)                                                                  |
| unauthenticated `initialize` → 2xx | **re-adopt** into `direct_mcp_accounts` with `custody: 'external'` and no `tokensRef` — it works |
| `401`/`403`                        | **drop** — this row is the fabricated-success artifact                                           |
| unreachable / 5xx                  | **keep**, mark `expired`, retry next boot — never destroy user state on ambiguity                |

Idempotency is inherent: a dropped row cannot be dropped twice, an adopted row now has a `direct_mcp_accounts` row and is skipped, and a deferred row resolves on a later boot. **Any drop raises a one-time user-visible notice, not a log line** — a durable activity event naming each dropped service and why ("Linear was listed as connected but was never actually signed in"), plus a `warnings[]` entry on the accounts aggregation (ADR-0310 pattern) so `/connections` shows it immediately. A silent deletion of something the UI called connected is exactly the dishonesty this spec exists to remove.

New directory `services/connectors/direct/`:

| File                       | Owns                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `oauth-client-provider.ts` | `DirectOAuthClientProvider implements OAuthClientProvider` — one instance per auth session |
| `token-store.ts`           | The tokens blob + client-registration blob in `EncryptedFileCredentialStore`               |
| `loopback-listener.ts`     | The `127.0.0.1` callback listener, port ladder, TTL, one-shot state                        |
| `discovery.ts`             | The three SDK gaps: `native`, RFC 9207, S256-absent refusal                                |
| `probe.ts`                 | `verifyAuthenticatedMcp()` — the `initialize` handshake gating `connected`                 |
| `identity.ts`              | The `identityHint` ladder for duplicate detection                                          |
| `failure-copy.ts`          | One plain sentence per typed failure, server-owned (mirrors `custody-disclosure.ts`)       |
| `catalog.ts`               | The ship-pinned, flag-gated vendor catalog                                                 |
| `google-workspace.ts`      | Google's pre-registered-client path + BYO hatch                                            |
| `accounts-store.ts`        | `direct_mcp_accounts` read/write                                                           |

### 2. The authorization ladder

`DirectOAuthClientProvider` satisfies the SDK's `OAuthClientProvider` and `auth()` drives the ladder (`auth.js:226-258`): `clientInformation()` returns a cached or pre-registered client (rung 1) → when the AS advertises `client_id_metadata_document_supported`, `clientMetadataUrl` is used as the `client_id` verbatim (rung 2, CIMD) → otherwise `registerClient` POSTs to `registration_endpoint` (rung 3, DCR — deprecated but MAY) → an AS with neither leaves us at rung 4: fail with `registration-refused` and a sentence telling the user this server needs a client id they must supply. `redirectToAuthorization(url)` does not redirect — it is server-side, so it captures the URL for `ConnectStart.authorizeUrl`.

`clientMetadata` (also the CIMD document's body — one constant, two consumers, so they can never drift):

```ts
{ client_name: 'DorkOS', client_uri: 'https://dorkos.ai',
  logo_uri: 'https://dorkos.ai/icon-512.png',
  tos_uri: 'https://dorkos.ai/terms', policy_uri: 'https://dorkos.ai/privacy',
  application_type: 'native',            // MUST (SEP-837) — see gap 1
  redirect_uris: [ 'http://127.0.0.1:4266/oauth/callback', …4267, …4268, …4269 ],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'], token_endpoint_auth_method: 'none' }
```

**The three gaps we close.**

1. **`application_type: "native"`.** `OAuthClientMetadataSchema` (`shared/auth.js:145-164`) is `.strip()` and lacks the field, but `registerClient` POSTs `{...clientMetadata}` raw (`auth.js:908-912`), so it reaches the wire. The TS type must be widened locally (`OAuthClientMetadata & { application_type: 'native' }`). **A regression test asserts the field is present in the DCR POST body against the fake auth server** — without `native`, OIDC defaults to `"web"` and rejects localhost redirects, which is the whole point of SEP-837.
2. **RFC 9207 issuer validation.** The SDK never touches `iss`. `discovery.ts` records the expected `issuer` from the AS metadata on the flow record; the callback compares the `iss` query parameter and, on mismatch, **discards the code without exchanging it** and fails `issuer-mismatch`. A missing `iss` when the AS advertised `authorization_response_iss_parameter_supported: true` is also a mismatch; a missing `iss` from an AS that never advertised it is accepted with a debug log (the parameter is not universally deployed yet).
3. **S256-absent refusal.** `startAuthorization` checks `code_challenge_methods_supported` only when present (`auth.js:696`). We pre-check the AS metadata: absent, or present without `S256`, fails `no-pkce-s256` before any browser hop.

RFC 8707 comes free — `selectResourceURL` binds `resource` to the canonical server URI whenever PRM exists, and we implement `validateResourceURL` to assert the returned resource matches the server we are connecting and to record it on the flow.

**`prompt` must be MERGED, never appended.** The SDK is not `prompt`-free: `startAuthorization` **appends** `prompt=consent` whenever the resolved scope includes `offline_access` (`auth.js:719-724`, `.append` not `.set`). Naively adding our own `prompt=login` therefore emits the parameter **twice**, which RFC 6749 §3.1 forbids ("MUST NOT be included more than once") and which OIDC cannot express anyway — `prompt` is a single space-delimited value list. The merge happens in `redirectToAuthorization(url)`, which receives the built, mutable `URL`: read every existing `prompt` value, union it with ours, and `set` one space-delimited value. A test asserts the authorize URL carries **exactly one** `prompt` parameter when the scope includes `offline_access`.

This bites **Google (D4) first**, since Google's desired value is already multi-valued (`select_account consent`) and would collide with the SDK's `consent` — the merge must dedupe rather than concatenate. Default value is `login`, overridable per catalog entry via `authParams`. **Honest scope note: whether an MCP auth server honors `prompt` at all is unproven per vendor.** Forcing a fresh sign-in is best-effort; the guarantee we actually give is post-grant duplicate detection (§4).

### 3. The loopback listener

Bind order matters: the listener binds **before** `startConnect` returns, so we only ever issue a redirect URI on a port we already hold. Ladder `4266 → 4269`; all four exhausted fails `listener-unavailable`. One listener per process, shared across concurrent flows, refcounted and closed when the last flow terminates or on process exit.

Three consequences of a shared ladder across concurrent instances, which this repo has routinely (worktrees):

- **A late callback can land on the wrong instance.** Instance A binds 4266, its flow times out, A releases the port, B binds it — and A's stale consent tab finally redirects into B. B correctly rejects it (unknown `state`), but the user sees a **bare 400 page** with no idea why. The listener's 400 body must therefore be honest and self-explanatory: this sign-in took too long or belongs to another DorkOS window, start it again. Still no input reflection.
- **Five instances exhaust the ladder.** With four ports and a listener held for the duration of a flow, a fifth concurrent connect has nowhere to bind. The `listener-unavailable` copy must say the useful thing — finish or close a connect that is open in another DorkOS window — not name ports the user cannot act on.
- **Each instance registers its own DCR client.** The client-registration blob is per-process state under `{dorkHome}`, so isolated instances with separate data directories each register separately with the same vendor. Some vendors rate-limit `/register`. Harmless at founder scale, worth knowing before a fleet of worktrees starts connecting the same vendor; the CIMD rung (§10) removes the problem entirely, since a URL-based `client_id` needs no registration round-trip.

Hardening: bound to the `127.0.0.1` interface explicitly, never `0.0.0.0` or `::`. Only `GET /oauth/callback` is served; every other method and path gets a bodyless 404. `state` is 32 random bytes, base64url, one-shot — the verifier is claimed and nulled exactly as `OpenRouterOAuthStore.claimVerifier` already does, so a replayed callback cannot re-exchange. An unknown or expired `state` returns a generic 400 that never reflects input. The landing page is static HTML with no external assets and no query reflection (reuse the existing `escapeHtml` helper from `routes/runtimes.ts`), and links back to the cockpit at its in-process port. Flows expire after 10 minutes. **Nothing logs a code, a verifier, a token, or a `state`** — the log line is `{ slug, flowId, outcome }`.

### 4. Multi-account

The single-account rejection at `raw-mcp.ts:117-122` is deleted. Each completed grant is one `ConnectedAccount` with its own tokens blob, its own row, and its own `identityHint`. Per-account tool-server naming needs no new code: `session-exposure.ts:_mintServerName` already derives `toolkit-label` and suffixes collisions, pinned for the session lifetime.

**Label resolution**, in order: an explicit `label` from the caller → the resolved `identityHint` → `<slug>-<n>`. So two Linears become `linear-dorian-personal` and `linear-dorian-work` when identity resolves, `linear` and `linear-2` when it does not.

**`identityHint` ladder** (each rung records its own `identityHintSource`, so the UI never implies more certainty than we have):

| Rung | Source                                                         | Trust      |
| ---- | -------------------------------------------------------------- | ---------- |
| 1    | OIDC `userinfo_endpoint`, when advertised and `openid` granted | verified   |
| 2    | `sub` + `iss` of the access token when it parses as a JWT      | unverified |
| 3    | none — the user labels the account and we cannot dedupe        | none       |

Rung 2 is a **local dedupe key only** — the JWT is not signature-verified and must never be treated as an authorization decision. A hint matching an existing account for the same server fails `duplicate-identity` with copy that names the fix (sign out in that browser, or use a different browser profile) and offers connect-anyway.

### 5. `pollConnect`, honestly

```
unknown flow                        → failed(unknown-flow)
no callback yet, within TTL         → pending
callback carried an OAuth error     → failed(user-cancelled | <as-error>)
state/issuer mismatch               → failed(state-mismatch | issuer-mismatch)   [code discarded]
token exchange failed               → failed(token-exchange-failed)
initialize → 401/403                → failed(unauthenticated-probe)  [tokens discarded]
initialize → transport error / 5xx  → pending, up to 3 attempts, then failed(server-unreachable)
initialize → 2xx + valid result     → connected
```

`verifyAuthenticatedMcp(url, accessToken)` POSTs a JSON-RPC `initialize` with `Authorization: Bearer …`, `Accept: application/json, text/event-stream`, and the `MCP-Protocol-Version` header, bounded at 10s (the `boundedFetch` pattern). Success records `serverInfo` and the negotiated `protocolVersion`, and stamps `lastVerifiedAt`. A 401/403 discards the tokens — no half-account. A transport error keeps them and retries, because throwing away a good refresh token over a flaky network is the wrong trade.

Every failure code maps to exactly one sentence in `failure-copy.ts`, with a `never`-typed exhaustiveness guard copied from `custody-disclosure.ts:114`, so a new failure mode cannot ship without copy.

### 6. Custody

`ConnectorCustodySchema` gains `'direct'`; the drizzle `custody` enum list gains it too. **No SQL migration** — the column is plain `text NOT NULL` with no CHECK constraint (`drizzle/0029_clear_gateway.sql:6`). The `assertUnreachableCustody` guard makes the new copy a compile error until written:

> You sign in to {service} yourself. DorkOS keeps the key for this connection on this computer, encrypted — nothing about it leaves your machine. You can disconnect anytime.

`external` copy stays for the token-free server case.

### 7. Refresh + revocation

`toolServerForAccount` is the single refresh point. When `expires_at` is within 60s, refresh via the SDK's `refreshAuthorization`, **single-flight per account** (an in-flight promise map) — many auth servers rotate the refresh token, and a lost race would invalidate the account. Refresh failure marks the account `expired` and returns `null`, landing in the surfaced per-account warning path (`session-exposure.ts:254-257`) that already exists. No background poller.

`disconnect(accountId)`: POST the `revocation_endpoint` when advertised (RFC 7009, `refresh_token` first then best-effort `access_token`, bounded, failures logged not thrown) → delete both credential-store entries → delete the `direct_mcp_accounts` row → `registry.recordDisconnect` → drop live session exposure. The last step extends the existing seam: `SessionConnectorService.invalidateAccount(accountId)` beside the shipped `invalidateProvider(providerType)`, called from the disconnect path so a revoked account stops serving live sessions, not just new ones.

### 8. Google Workspace

Google runs no discovery on the MCP host (all six probed endpoints 405, POST-only, no `WWW-Authenticate`), so PRM is skipped and the AS is `accounts.google.com` directly — `https://accounts.google.com/.well-known/openid-configuration` resolves, which means Google is **rung 1 of the same ladder**, not a special flow. Only the client identity and the AS origin are pinned.

```ts
// connectors.direct.google in user config
{ clientId?: string,            // BYO — plain, not a secret; omitted = DorkOS default
  clientSecretRef?: string,     // 'file:'/'keychain:'/'env:' reference, BYO only
  products?: ('gmail'|'calendar'|'drive'|'docs'|'sheets'|'slides'|'chat'|'people')[] }
```

The DorkOS default client id is a build-time constant, not a credential-store entry — it is not a user secret. **Honest caveat to resolve at implementation:** Google issues desktop-app clients a `client_secret` that Google's own docs describe as not confidential (RFC 8252 §8.5 territory). Whether Google's token endpoint accepts a PKCE-only public client for these MCP scopes is **unverified** — D4 must probe it before shipping, and if a secret is required it ships as a build-time constant with the disclosure that it is not, and cannot be, secret. Per-product scopes are the narrowest that work; restricted Gmail scopes trigger CASA (Appendix A).

### 9. The catalog (flag-gated)

`connectors.direct.catalogEnabled: boolean` (default **false**), plus `DORKOS_DIRECT_CATALOG=1` for the founder's machine and the spike. `catalog.ts` is a ship-pinned constant; entries merge with `connectors.rawMcpServers`, and a user entry **wins** on slug collision — explicit config beats our default. The provider joins the bootstrapper's `reload()` set so flipping the flag or editing config takes effect without a restart; this is safe precisely because direct accounts are now durable (§Data model), so a rebuilt provider rehydrates rather than forgetting.

```ts
interface DirectCatalogEntry {
  slug: string;
  displayName: string;
  url: string;
  transport: 'http' | 'sse';
  capability: 'read-only' | 'read-write' | 'interactive'; // Claude's directory vocabulary
  authVerification: 'live-verified' | 'registration-only' | 'unverified' | 'incompatible';
  authParams?: Record<string, string>; // e.g. Google's prompt
  rateLimit?: { requests: number; windowSeconds: number }; // Sentry: 60/60s per user
  notes?: string;
}
```

`authVerification` is **hand-filled from a real grant** — registration success does not prove authorize-time acceptance, and Vercel, Square, and Figma all document client allowlists. Only `live-verified` entries may render without an "unverified" label. Slack is absent, with a code comment citing the prohibition, and a test asserts `recommendConnector('slack')` still ranks the Relay adapter at 0 with no catalog contribution. Sizing pool after D0: Linear, Notion, Stripe, Vercel, Sentry, Atlassian, Cloudflare, Supabase, Neon, Canva, Figma, Webflow, Intercom — Asana verify-first (docs and metadata conflict), Canva waitlisted, Intercom US-only.

### 10. CIMD hosting (an `apps/site` deliverable)

`https://dorkos.ai/oauth/dorkos-client.json`, a `force-static` Next.js route handler at `apps/site/src/app/oauth/dorkos-client.json/route.ts` (the `llms.txt/route.ts` pattern). The URL **is** the `client_id`. The SDK requires HTTPS with a non-root pathname (`isHttpsUrl`, `auth.js:233`).

Body = the `clientMetadata` constant of §2 plus a self-referential `"client_id": "https://dorkos.ai/oauth/dorkos-client.json"`, served `application/json`, `Cache-Control: public, max-age=3600, s-maxage=86400`, `Access-Control-Allow-Origin: *`.

**Stability requirements — this is a permanent contract, not a page.** The path never changes. A `redirect_uris` entry is only ever **added**, never removed or reordered. `client_name` never changes: it is the name on every consent screen. The document must be reachable with no auth, no redirect, and no 4xx/5xx — a fetch failure breaks every direct connect for every user at once. A site-side test pins the redirect-URI array bytes and the presence of `application_type: 'native'`; the ports live in one shared constant so app and site cannot drift. **Deploy ordering: the site ships first, the app second** — the app must never issue a redirect URI the published document does not yet list.

### Code structure & file organization

| Path                                                                            | Change                                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/server/src/services/connectors/direct/**` (+ tests)                       | **new** — 10 modules, §1 table                             |
| `apps/server/src/services/connectors/providers/direct-mcp.ts`                   | **rename + rewrite** of `raw-mcp.ts`                       |
| `apps/server/src/services/connectors/session-exposure.ts`                       | edit — persistence, `invalidateAccount`                    |
| `apps/server/src/services/connectors/bootstrap.ts`                              | edit — direct provider joins `reload()`, legacy-row purge  |
| `apps/server/src/routes/connectors.ts`                                          | edit — `allowDuplicateIdentity`, typed failure passthrough |
| `packages/shared/src/connector-provider.ts`                                     | edit — `'direct'` custody, failure codes, connect opts     |
| `packages/shared/src/config-schema.ts`                                          | edit — `connectors.direct.{catalogEnabled,google}`         |
| `packages/db/src/schema/{direct-mcp-accounts,session-connector-attachments}.ts` | **new** + one drizzle migration                            |
| `packages/db/src/schema/connected-accounts.ts`                                  | edit — custody enum list                                   |
| `apps/client/src/layers/features/connections/ui/ConnectDialog.tsx`              | edit — honest states, connect-again                        |
| `apps/site/src/app/oauth/dorkos-client.json/route.ts` (+ test)                  | **new** — CIMD document                                    |
| `docs/connectors/*.mdx`, `contributing/adding-a-connector.md`                   | edit — direct custody, catalog flag, BYO Google            |
| `research/<date>_direct-mcp-linear-spike.md`                                    | **new** — D0 evidence                                      |
| `changelog/unreleased/<id>-*.md`                                                | one fragment per PR                                        |

### API changes

No new REST routes. `POST /api/connectors/:provider/connect` accepts `allowDuplicateIdentity?: boolean`; `GET /api/connectors/flows/:flowId` gains a `failureCode` beside its existing `error` sentence. The loopback callback is **not** an Express route — it is the separate `127.0.0.1` listener, deliberately not reachable through the cockpit's port. OpenAPI regenerated.

### Data model changes

Two new tables, one migration. `direct_mcp_accounts`: `accountId` (PK), `slug`, `serverUrl`, `issuer`, `clientId`, `tokensRef`, `scope`, `expiresAt`, `identityHint`, `identityHintSource`, `protocolVersion`, `lastVerifiedAt`, `createdAt` — **refs only, no secrets**. `session_connector_attachments`: `sessionId`, `accountId`, `serverName`, `attachedAt`, PK `(sessionId, accountId)`, index on `sessionId`. Rehydrated lazily on first `attach`/`status`/`mcpServersForSession` for a session, not at boot; rows whose account is gone are dropped self-healingly; rows are deleted with their session.

The startup orphan sweep covers **three** leaks, the third of which the two obvious sweeps miss: `attach` accepts a session id that does not exist and never validates it (`routes/session-connectors.ts:47-51` — 404s only on an unknown _account_), which the redesign's try-it-now flow turns into a routine event, since it mints a speculative client-side UUID and attaches before the user has sent anything. A user who then closes the tab leaves a row whose session will never exist. So the sweep drops rows (a) whose account is gone, (b) whose session was deleted, and (c) **whose session id has no corresponding session at all and whose `attachedAt` is older than 24h** — the window exists so a legitimately speculative attach, made seconds before the session is created, is never swept out from under a live flow. `connected_accounts` gains one enum value, no SQL change.

## User Experience

Connecting reads as: click connect → the custody sentence, which is now the true one → the service's own sign-in page with **DorkOS** on it → back to the cockpit, connected. Connecting a second account of the same service is the same flow with a "Connect another" affordance; the two accounts show their labels, and if the same account comes back twice DorkOS says so instead of quietly duplicating. Every failure names what happened and what to do. Pre-empt one surprise in copy: the MCP spec directs auth servers to warn about localhost-only redirect URIs and to display the redirect hostname, so consent screens may look slightly scarier for a local app — say so before the user sees it. All copy through `writing-for-humans`; works at every breakpoint.

## Testing Strategy

- **`FakeMcpAuthServer`** (`direct/__tests__/fake-mcp-auth-server.ts`) is the backbone: a switchable in-process HTTP server that can 401 with a `WWW-Authenticate` `resource_metadata` pointer, serve PRM + AS metadata with each flag on or off (`client_id_metadata_document_supported`, `registration_endpoint`, `code_challenge_methods_supported` absent/no-S256, `authorization_response_iss_parameter_supported`), accept or refuse DCR while asserting the POST body, issue codes validating PKCE S256 + exact `redirect_uri` + `resource`, return a correct/absent/**wrong** `iss`, rotate refresh tokens, revoke, and serve an MCP `initialize` that 401s without a bearer.
- **Ladder units:** each rung selected under the right metadata; rung 4 fails honestly; `application_type: 'native'` **asserted present in the DCR body**; S256-absent refuses before any browser hop; wrong `iss` fails without exchanging the code; `resource` present and matching.
- **Listener units:** ladder walks on collision; all-taken fails honestly; bound to `127.0.0.1`; non-callback paths 404; replayed `state` refused; TTL expiry; no secret in any log line (assert on a captured logger).
- **Multi-account units:** two grants → two accounts, two tokens, two server names; duplicate identity refused then accepted under override; label resolution across all three identity rungs.
- **`pollConnect` units:** the full §5 table, one case each; `connected` unreachable without a 2xx `initialize`; 401 discards tokens; transport error retries then fails.
- **Refresh/revocation units:** single-flight under two concurrent resolves; rotation persisted; failure → `expired` + null branch + warning; revocation called when advertised, skipped when not, failure never thrown.
- **Persistence units:** attachments survive a simulated restart with `serverName` intact; dead-account rows dropped; orphan sweep.
- **Site unit:** the CIMD document's redirect-URI bytes and `application_type` pinned; shared port constant asserted identical to the server's.
- **Playwright** (`apps/e2e`): the UI states against the fake auth server under `DORKOS_TEST_RUNTIME` — connect → connected, connect-again, each failure state, disconnect. **A real-vendor grant cannot be automated**; it is hand-carried (D0) and re-carried per catalog entry.
- **Conformance:** the rewritten provider passes `connectorConformance` on the `supportsMultiAccount: true` branch.
- `pnpm verify` per PR; changelog fragment per PR.

## Security Considerations

Token custody: every token lands only in `EncryptedFileCredentialStore` (AES-256-GCM under `{dorkHome}`), addressed by reference; no token, refresh token, code, verifier, or `state` may appear in a log line, an API response, a DB column, or an error message — asserted, not assumed. The callback listener binds the `127.0.0.1` interface only, binds before any redirect URI is issued (so a squatter cannot receive a code for a URI we never sent), serves exactly one path, and reflects nothing. Redirect URIs are exact-match against the published CIMD document and are `127.0.0.1` literals, never `localhost`. PKCE S256 is mandatory and unadvertised support is a hard refusal. `resource` (RFC 8707) is bound on every authorize and token request as the confused-deputy defense; `iss` (RFC 9207) is validated as the mix-up defense, with the code discarded on mismatch. The rung-2 JWT `sub` is a local dedupe key and never an authorization input. Disconnect revokes upstream where advertised and drops live session exposure through the extended `invalidateAccount` seam. `McpAppServerConnection` values — which now carry a bearer header — continue never to reach the browser (`routes/connectors.ts` strips them today). The custody disclosure stays server-owned so no surface can drift from a true sentence.

## Documentation

`docs/connectors/*.mdx`: what direct connection is, the custody sentence, adding your own server, the BYO Google client, and the catalog flag's real state. `contributing/adding-a-connector.md`: the direct path and the `FakeMcpAuthServer`. Every vendor claim stays behind the demo-claim gate until a real grant exists.

## Implementation phases (see 03-tasks.json)

**D0 spike (Linear, real grant)** gates everything about vendors — it is a hard dependency of both the ladder (D1.4, which needs the OQ1/OQ3 answers) and the catalog (D5.1, whose sizing is the spike's whole purpose). **D1** OAuth machinery, with the authenticated-`initialize` probe (D1.6) deliberately split off the ladder's critical path so it parallelizes. **D2** multi-account + the `pollConnect` fix + revocation. **D3** persistence. Then **D4** Google, **D5** catalog, **D6** CIMD hosting in parallel. D6 has no code dependency on D1's ladder beyond the shared `clientMetadata` constant, and flips the one constant that enables the CIMD rung.

## Open Questions (with recommendations)

- **OQ1 — Fixed port ladder vs. RFC 8252 any-port loopback.** _Recommendation:_ ship the fixed ladder; it is the only option compatible with a static CIMD document. D0 records whether Linear accepts a port outside the registered set — if any-port turns out to be widely honored, a later revision can drop to one declared port.
- **OQ2 — Ladder rung 2 before D6 publishes.** _Recommendation:_ `clientMetadataUrl` returns the URL only when a `DIRECT_CIMD_URL` constant is non-empty; D6 flips it. An advertised-CIMD server with a 404 document would break where DCR would have worked, so the flip is D6's last acceptance criterion.
- **OQ3 — Does `prompt=login` do anything?** Unproven per vendor. _Recommendation:_ send it (unrecognized params MUST be ignored), guarantee nothing, and rely on post-grant duplicate detection. D0 reports Linear's behavior.
- **OQ4 — Google public client vs. desktop-app secret.** _Recommendation:_ D4 probes PKCE-only first; if a secret is required, ship it as a build-time constant with the plain disclosure that it is not secret and cannot be.
- **OQ5 — Where `FakeMcpAuthServer` lives.** _Recommendation:_ local to `direct/__tests__/` for now; graduate to `@dorkos/test-utils` when a second package needs it.
- **OQ6 — Catalog entries at v1.** _Recommendation:_ ship with **zero** entries and the flag off; add only `live-verified` vendors, one hand-carried grant at a time, after counsel clears founder decision 1.
- **OQ7 — Obsidian `DirectTransport`.** _Recommendation:_ read surfaces only; a clear "open the web cockpit to connect" notice for the connect path — never a silent failure.

## Appendix A — Google OAuth client: founder-ops checklist

Not a code task. Owner: founder. Blocks D4's default path only; the BYO hatch works without any of it.

1. **GCP project** — create a dedicated project (e.g. `dorkos-connect`), separate from anything else, so a verification problem cannot spill.
2. **Enable APIs** for each product whose MCP server ships: Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, People.
3. **OAuth consent screen** — External, Production. App name `DorkOS`, support email, logo, homepage `dorkos.ai`, privacy `dorkos.ai/privacy`, terms `dorkos.ai/terms`. Verify the domain in Search Console first; the name and logo here are what every user sees.
4. **Scopes** — add the narrowest per product. Sensitive scopes need justification and a demo video; **restricted** scopes (Gmail message content, full Drive) additionally require a CASA security assessment.
5. **OAuth client** — type **Desktop app**. Note the client id (and the secret Google issues, which Google itself documents as not confidential). Record both for the build-time constant.
6. **Verification submission** — scope justifications plus a screencast showing the consent flow and what each scope is used for. Expect **2–6 weeks** for sensitive scopes; longer with CASA.
7. **CASA** (restricted scopes only) — a third-party assessment against the Application Security Verification Standard, annually renewed, with a real cost. Decide per product whether a restricted scope is worth it, or whether a narrower scope ships instead.
8. **Pre-verification reality** — an unverified app is capped at 100 test users and shows an "unverified app" warning. Ship Google direct as **alpha, BYO-client-first** until verification lands; the DorkOS default client turns on when it does.
9. **Ongoing** — annual re-verification, annual CASA, and a re-review on any scope addition. Treat scope changes as a release-gated event.

## References

`/connections` design critique + fact-check, 2026-07-29 (§a.1, §b MCP-auth ladder, §b vendor matrix, §d P0b/P1/P5, §f 1–4). MCP specification 2026-07-28: `basic/authorization`, `basic/authorization/client-registration`. RFC 9728, 8414, 8707, 9207, 7591, 7636, 7009, 8252 §§7.3/8.3/8.5. SEP-837, SEP-991. `developers.google.com/workspace/guides/configure-mcp-servers`. Source verified 2026-07-29: `@modelcontextprotocol/sdk@1.29.0` `dist/esm/client/auth.js:226-258, 328-344, 685-720, 892-917` and `dist/esm/shared/auth.js:145-180`; `apps/server/src/services/connectors/{bootstrap,registry,session-exposure,custody-disclosure,flow-bindings,routing}.ts`, `providers/raw-mcp.ts`, `services/core/credential-provider.ts`, `services/runtimes/opencode/openrouter.ts`, `routes/{connectors,connector-providers,session-connectors,runtimes}.ts`; `packages/shared/src/{connector-provider,config-schema}.ts`; `packages/db/src/schema/connected-accounts.ts`, `packages/db/drizzle/0029_clear_gateway.sql`; `apps/site/src/app/llms.txt/route.ts`. Specs: `connector-gateway`, `connector-completion`. ADR `260718-045630` (custody), ADR-0043, ADR-0310, ADR-0315.
