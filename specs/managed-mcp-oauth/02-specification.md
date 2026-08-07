# Spec: OAuth sign-in for managed MCP servers (DOR-938)

Source: review of the 2026-08-06 meeting-notes/Granola session. A user added the
official Granola MCP server (`https://mcp.granola.ai/mcp`, OAuth) to an agent via
`mcp.add`; it registered + enabled but sat permanently **401** because there is no
way to complete OAuth from inside DorkOS. This spec closes that loop.

> **This spec is assembled from a design spike + a moving tree. Anything here that
> turns out wrong on contact with the code, correct it — the implementer executed,
> the author remembered.** Every file:line below was read during the spike but the
> tree moves; re-verify before relying on a line number.

## The decision that shapes everything

The Claude Agent SDK's `options.mcpServers` http/sse entries are **static-headers
only** — `McpHttpServerConfig = { type:'http'; url; headers?; tools?; timeout?;
alwaysLoad? }` and the sse variant is identical (`@anthropic-ai/claude-agent-sdk`
`sdk.d.ts` ~:1019-1147). There is **no** `authProvider` / token-callback field.

Therefore **DorkOS owns the entire OAuth lifecycle** (discover → dynamic client
registration → authorization-code + PKCE → token exchange → refresh) and injects
`Authorization: Bearer <access_token>` into the entry's `headers` at
session-injection time, refreshing before expiry. The subprocess never does OAuth;
it just receives a header (or, with no token yet, doesn't — and reports
`needs-auth`).

Patterns to mirror:

- **UX / state machine** — the connector sign-in flow: `connector.start_connect` /
  `connector.poll_connect` (`services/connectors/connector-capabilities.ts`
  ~:206-328), custody disclosure (`services/connectors/custody-disclosure.ts`),
  client `use-connect-flow.ts` (`idle→starting→disclosure→waiting→connected`),
  `ConnectDialog.tsx` (disclosure-before-URL, plain `<a target=_blank>`).
- **Token mechanics** — the OpenRouter loopback OAuth: `routes/runtimes.ts`
  (~:233-268: `.../oauth/start`, `.../oauth/callback` loopback-only + HTML return
  page, `.../oauth/status`) and `services/runtimes/opencode/openrouter.ts` (PKCE
  `generatePkce()`, in-memory state store `OpenRouterOAuthStore` ~:151-207). Do
  **not** mirror the connector `raw-mcp` provider — it is a stub that returns the
  server URL as the "authorizeUrl" and never persists a token
  (`services/connectors/providers/raw-mcp.ts` ~:90-148).
- **MCP SDK OAuth primitives** (`@modelcontextprotocol/sdk` v1.29.0,
  `dist/esm/client/auth.*`): `OAuthClientProvider` interface (`redirectUrl`,
  `clientMetadata`, `clientInformation`/`saveClientInformation`, `tokens`/
  `saveTokens`, `redirectToAuthorization`, `saveCodeVerifier`/`codeVerifier`), the
  `auth(provider,{serverUrl,authorizationCode?})` orchestrator (returns
  `'REDIRECT'` then `'AUTHORIZED'`), `registerClient` (DCR), discovery
  (`discoverOAuthProtectedResourceMetadata` RFC 9728,
  `discoverAuthorizationServerMetadata` RFC 8414), `startAuthorization` (PKCE +
  authorize URL), `exchangeAuthorization`, `refreshAuthorization`. Transport
  wiring: `StreamableHTTPClientTransport({ authProvider })` +
  `.finishAuth(code)` — used **only** on the DorkOS acquisition side, out-of-band
  from the SDK subprocess.

## Token storage

Reuse the existing encrypted store: `ExtensionSecretStore` (AES-256-GCM,
scrypt-derived host key) behind `EncryptedFileCredentialStore`
(`services/core/credential-provider.ts` ~:115-140; crypto in
`packages/shared/src/extension-secrets.ts`). Create a **dedicated store id**
`mcp-oauth` under `{dorkHome}` (constructor takes `dorkHome` — honor the
`os.homedir()` ban / `lib/dork-home.ts`), keyed **per-agent + per-server**
(`${agentId}:${serverName}`). Store `OAuthTokens` + DCR client info + (transiently)
the PKCE verifier. **Refresh tokens never touch the manifest**; `.dork/agent.json`
`McpServerTransportSchema.headers` is plaintext on disk.

## The core risk: sync injection vs async store

`injectableServersForCwd` → `readEnabledServersSync`
(`services/mesh/agent-mcp-server-service.ts` ~:313-330, 455-486) is **synchronous**
(`statSync`/`readFileSync`), but the encrypted store + refresh are **async**. So the
current access token must be readable **synchronously** at injection time.

Design: a **token-manager** that holds a decrypted **in-memory cache** of current
access tokens keyed by `(agentId|cwd, serverName)`, warmed on boot/add and
**background-refreshed** before `expires_at`. The sync injection merges
`Authorization: Bearer <cachedToken>` into `connection.headers` **only when a live
token exists**, and withholds it otherwise (safe default: absence → no header →
`needs-auth`). Do the merge at the **runtime-neutral** layer (`readEnabledServersSync`)
so codex/opencode benefit too, not only claude-code's `toSdkMcpServerConfig`.

---

## Execution split

### W1a — server engine, capabilities, callback, injection, wording (the engine)

**Shared** (`packages/shared`)

- Optional non-secret `authKind?: 'oauth2'` on the http/sse variants of
  `McpServerTransportSchema` (`src/mesh-schemas.ts`), so DorkOS knows a server
  expects a token without a runtime round-trip. (Do NOT add Transport client
  methods here — they'd be dead code until W1b; add them in W1b with their use.)

**Server** (`apps/server`)

- `services/mesh/agent-mcp-oauth-service.ts` (new, keep <300 lines; split if
  needed): `OAuthClientProvider` impl backed by `ExtensionSecretStore('mcp-oauth',
dorkHome)`; a flow store mirroring `OpenRouterOAuthStore`; drives the MCP SDK
  `auth()`/`exchangeAuthorization()`/`refreshAuthorization()`; maintains the
  **synchronous in-memory access-token cache** + background refresh.
- Capabilities `mcp.signin` + `mcp.poll_signin` in
  `services/mesh/mcp-capabilities.ts` (mirror `connector.start_connect`/
  `poll_connect`): `mcp.signin` returns `{ flowId, authorizeUrl, disclosure,
message }` (custody disclosure shown verbatim); `mcp.poll_signin` returns
  `pending | connected | failed`. Tier: `act` (starting a sign-in isn't
  destructive; it stores a token for a server the operator already approved).
- Loopback callback route mirroring OpenRouter (loopback-only guard + HTML
  "return to DorkOS" page), plus start/status as needed. Place under `routes/`
  (extend the mesh/agent routes or a new `mcp-oauth` route). `redirectUrl` in
  `clientMetadata` points here.
- **Injection change**: `readEnabledServersSync` merges the bearer header for
  http/sse entries when the token cache has a live token; withholds otherwise.
- **`test()` classification**: on a 401 / unauthorized probe result, return a
  structured `{ ok:false, needsAuth:true, error }` (detect via the
  `WWW-Authenticate` header / 401 status), instead of only the raw SDK string, so
  the client (W1b) can render "Needs sign-in". Keep the raw error for other
  failures.
- **#3 wording fix**: the `enable()` docstring and `mcp.enable`/related capability
  descriptions say tools inject "into the agent's **next session**". The real
  mechanism recomposes `mcpServers` **every turn** on the same resumed session
  (`message-sender.ts` ~:491-492, 593, 665) — a server enabled mid-conversation is
  live on the **next turn/message**, no restart. Fix the wording to match. Verify
  the mechanism yourself before rewording.

**Tests (discriminating — REVIEW.md "a passing test is not evidence"):**

- token cache returns the current token; background refresh replaces an
  about-to-expire token; injection merges the header iff a live token exists and
  withholds it otherwise (assert both branches).
- capability flow against an **in-process mock OAuth provider**: `mcp.signin` →
  auto-approved code → `mcp.poll_signin` connected → token persisted (encrypted) →
  injection now yields the header.
- `test()` returns `needsAuth:true` on a 401.
- For each: revert the change, confirm the intended test reddens and nothing
  unrelated does. Report what reddened.

**Acceptance W1a:** an agent calls `mcp.signin` for an added OAuth server, gets a
real sign-in link + custody disclosure; after the browser (mock, auto-approve)
completes, `mcp.poll_signin` reports connected, the token is stored encrypted, and
the server's tools are injected (bearer header present) and callable on the next
turn. `test()` reports `needsAuth` when unauthenticated. This alone answers the
original "can you trigger the sign-in for me?" via the agent-facing capability.

### W1b — client Sign in UI + status legibility + e2e (blocked by W1a)

**Shared:** Transport methods `startMcpSignin` / `pollMcpSignin` (near the
connector methods in `src/transport.ts`) + their `HttpTransport` impls over the
W1a routes.

**Client** (`apps/client`)

- `use-mcp-signin-flow` hook (mirror `use-connect-flow.ts`) — put it in an
  entities-layer module (`entities/agent` or a new `entities/mcp-oauth`), never a
  cross-feature model import (FSD).
- `AgentMcpServers.tsx` `ManagedServerRow`: a **"Sign in"** button in the action
  cluster gated on `live?.status === 'needs-auth'`; disclosure-before-URL like
  ConnectDialog; on success the live status flips to `connected`.
- **Status legibility (#2)**: the `needs-auth` amber dot exists but is
  `aria-hidden` with no label (`AgentMcpServers.tsx` ~:45,58). Give the status a
  visible text chip + tooltip ("Needs sign-in" / "Connected" / "Failed"). Map the
  W1a classified `needsAuth` test result to "Needs sign-in — click Sign in",
  instead of the raw `Streamable HTTP error: … {"message":"Unauthorized"}` string.

**e2e** (`apps/e2e`) — the real proof for CI

- New **test-mode-gated mock OAuth-protected MCP server** (server-source Express
  sub-router mounted like `routes/test-control.ts`; there is no standalone HTTP
  mock-server fixture today — everything runs in-process). It must implement:
  `GET /.well-known/oauth-protected-resource` (RFC 9728),
  `GET /.well-known/oauth-authorization-server` (RFC 8414 with registration/
  authorization/token endpoints), `POST /register` (DCR), `GET /authorize` (302
  back to the DorkOS loopback callback with `?code=&state=`, auto-approve like
  `/api/test/connect-approved`), `POST /token` (authorization_code validating PKCE
  - refresh_token grants), and a protected streamable-http MCP endpoint (401 +
    `WWW-Authenticate` until a valid bearer, then a normal `listTools`).
- New spec mirroring `apps/e2e/tests/connections/connections.spec.ts` + a page
  object mirroring `apps/e2e/pages/ConnectionsPage.ts`: add http MCP server → row
  shows `needs-auth` → "Sign in" → open link (auto-approve) → poll → `connected`
  with N tools; assert the encrypted token was stored and the header injected.

**Acceptance W1b:** Playwright drives the full add→needs-auth→Sign in→approve→
connected(N tools) flow green in CI; client tests cover the button gating + status
copy; reverting reddens them.

---

## What is NOT in scope (name it so a fresh reader doesn't "fix" it back into a bug)

- **Real-provider generality.** DCR + a registerable loopback `redirect_uri` is
  assumed (RFC 7591). Some real providers disallow localhost redirects or require
  pre-registered clients; a manual `client_id/secret` fallback is a **follow-up**,
  not W1. The mock + real-Granola check are the two proofs; a matrix of providers
  is out of scope.

  **Half of this closed in DOR-982**, and it is worth being precise about which
  half. `mcp.set_client` stores operator-supplied client credentials in the same
  encrypted slot DCR writes to, and the SDK's `auth()` then skips registration
  entirely (it only registers when `clientInformation()` answers empty), so a
  provider that **requires a pre-registered client** is now signable-in. A
  provider that **rejects the loopback `redirect_uri`** is not, and cannot be
  detected from here: that refusal happens on the provider's own authorize page,
  in the person's browser, and never reaches the callback. The UI is scoped
  accordingly — the form offers app credentials and promises nothing about
  redirect policy. A separate remote/public callback would be the fix for that
  half, and it remains out of scope.

- **Revocation/expiry-mid-session detection seam.** `refreshAuthorization`
  preserves the old refresh token when none is returned; rotation + 401-after-
  connect should flip the row back to `needs-auth`. Wire the happy path + refresh;
  the full staleness-detection seam (poll `mcpServerStatus()` vs re-probe) can be a
  follow-up if it balloons — but note it explicitly in the PR if deferred.
- Codex/opencode-specific OAuth UI. The injection change is runtime-neutral, but
  the "Sign in" UI ships for the managed-server list; per-runtime niceties are
  later.

## Final verification (program close)

- W1b's mock-OAuth Playwright spec green in CI.
- A **real-Granola** browser run against a dev cockpit (operator is signed into
  Granola): add the server → Sign in → pull actual meetings. This is the
  browser-verified close, not a unit-suite claim.
