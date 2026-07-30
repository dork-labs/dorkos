---
slug: direct-connect
id: 260729-234947
created: 2026-07-29
status: ideation
---

# Direct connect — the front door, with the key on your machine

**Author:** spec-direct (IDEATE stage)
**Date:** 2026-07-29
**Input:** `/connections` design critique + fact-check (2026-07-29, consolidated round 1), §(d) P0b/P1/P5 and §(f) founder decisions 1–4.
**Shipped code read first:** `apps/server/src/services/connectors/**`, `packages/shared/src/connector-provider.ts`, `packages/db/src/schema/connected-accounts.ts`, `apps/server/src/services/runtimes/opencode/openrouter.ts`, `@modelcontextprotocol/sdk@1.29.0` `client/auth.js`.

## The problem, in one sentence

Roughly a dozen services a DorkOS user actually wants — Linear, Notion, Stripe, Vercel, Sentry, Supabase, Neon, and Google's own Workspace servers — run standards-compliant remote MCP servers a local app can authenticate against directly, with the OAuth token never leaving the user's disk; DorkOS instead routes everyone through a third-party credential vault, and the one adapter that could connect directly (`providers/raw-mcp.ts`) hands the user a raw JSON error page and then reports success.

## Verified state of the ground (read from source, 2026-07-29)

| Fact                                                                                                                                          | Where                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `startConnect` returns the MCP endpoint URL itself as `authorizeUrl` — the user opens it and gets `{"error":"invalid_token"}`                 | `providers/raw-mcp.ts:128`                              |
| `pollConnect` sets `status: 'connected'` **unconditionally**, minting an account with no authentication of any kind                           | `providers/raw-mcp.ts:131-149`                          |
| The adapter is single-account by construction (`mcp:<slug>` id, second connect rejected)                                                      | `providers/raw-mcp.ts:60-62, 117-122`                   |
| No token custody exists — `custody: 'external'`, "DorkOS holds NO tokens"                                                                     | `providers/raw-mcp.ts:8-12`                             |
| Session attachments are **in memory, process-scoped**; a restart silently loses them                                                          | `session-exposure.ts:36-44`                             |
| `connectors.rawMcpServers` is read at boot only; no display metadata, no custody or capability facets                                         | `config-schema.ts:563-579, 1217-1222`                   |
| The custody enum has three members and a `never`-typed exhaustiveness guard, so a fourth class is a compile error until its copy exists       | `connector-provider.ts:36`, `custody-disclosure.ts:114` |
| A loopback PKCE pattern already ships and works: server-held verifier, one-shot claim, opaque `state`, minimal callback HTML, pollable status | `services/runtimes/opencode/openrouter.ts`              |
| Per-account MCP server naming, collision-safe and pinned for the session lifetime, already ships                                              | `session-exposure.ts:158-167, 362-380`                  |
| `headers` on an `McpAppServerConnection` already plumbs to the runtime unchanged — a bearer token needs no new seam                           | `claude-code/mcp-server-config.ts:25-38`                |
| The live-revocation seam already exists as `onUnregistered(providerType)`                                                                     | `bootstrap.ts:89-95, 284-291`                           |
| `connected_accounts.custody` is plain `text NOT NULL` — no CHECK constraint, so a fourth enum member needs **no SQL migration**               | `packages/db/drizzle/0029_clear_gateway.sql:6`          |

**The find that changes the shape of the work:** `@modelcontextprotocol/sdk@1.29.0` — already a direct dependency of `apps/server` — implements most of the 2026-07-28 authorization ladder. `client/auth.js` does RFC 9728 PRM discovery, RFC 8414/OIDC AS discovery, the exact registration priority ladder (pre-registered → CIMD via `client_id_metadata_document_supported` + `clientMetadataUrl` → DCR → throw, lines 226-258), PKCE S256, RFC 8707 resource indicators, token exchange, and refresh. Three MUSTs it does **not** do, which DorkOS must:

1. **`application_type: "native"`** is absent from `OAuthClientMetadataSchema` (`shared/auth.js:145-164`). `registerClient` POSTs `{...clientMetadata}` raw, so the field reaches the wire if we put it there — but the type does not admit it and a future SDK that parses through the strict schema would silently drop it. Needs a pinned regression test, not a comment.
2. **RFC 9207 issuer validation** — no `iss` handling anywhere in `client/auth.js`. Ours to record and check.
3. **Refusing an S256-incapable server** — the SDK checks `code_challenge_methods_supported` only when the field is _present_ (`auth.js:696`). The spec says a client MUST refuse when it is absent.

So this is not "write an OAuth client." It is "implement an `OAuthClientProvider` over DorkOS's credential store and a loopback listener, then close three spec gaps and prove it against one real vendor."

## What "done" looks like (jobs to be done)

1. **"Connect my Linear."** One click, Linear's own consent screen with DorkOS's name on it, back to the cockpit connected — and connected means a real authenticated MCP handshake happened, not that a string exists.
2. **"Both my Linears."** Two workspaces, two accounts, two distinctly-named tool servers in one session, each with its own token. The founder's own case.
3. **"Still there tomorrow."** Tokens survive a restart, encrypted at rest; session attachments survive a restart; an expired token refreshes silently and a dead one says so.
4. **"Nothing left my machine."** A fourth custody class that is true: `Direct — the key stays on your machine`.
5. **"And Gmail."** Google's own `<product>mcp.googleapis.com` servers, reached with a DorkOS-registered OAuth client by default and a BYO client for anyone who wants their own.
6. **"Nothing fake."** Every failure mode has an honest sentence. No green badge over a dead connection.

## Options considered

- **Keep routing everything through the managed vault.** Rejected by founder decision 4 (kill the DorkOS-held platform key) and by the critique's §(e): the vault is a shortcut past OAuth-client registration, not a foundation, and its name is unhideable on the consent screen.
- **Hand-roll the OAuth 2.1 client.** Rejected: the SDK already ships the ladder, is already a dependency, and tracks the spec revision. Hand-rolling means owning PRM/AS discovery and DCR forever to close three gaps.
- **Split direct into a second provider (`type: 'direct'`) beside `raw-mcp`.** Rejected: two providers would list overlapping toolkits and the registry would have to dedupe. Instead one provider, static custody `direct`, with `ConnectedAccount.custody` — which already echoes per account — carrying `external` for the rare server that needs no token at all.
- **Reuse the cockpit's own port for the OAuth callback** (the OpenRouter pattern). Rejected: the cockpit port varies (4242 prod, 6242 dev, per-worktree in between) and a hosted CIMD document cannot enumerate them. Redirect-URI exact match needs port stability, so the callback gets its own small listener on a fixed ladder.
- **Remote-updatable vendor catalog.** Deferred: it puts a network dependency on `dorkos.ai` under a core surface, needs content signing to be trustworthy, and needs live reload. Ship-pinned to the release train for v1.

## Scope shape

Two independent ship gates, deliberately:

- **Ungated (ships first):** everything about _mechanism_. A user adds a server (`connectors.rawMcpServers`, or a "add a server" affordance later), and DorkOS authenticates it properly, multi-account, with real tokens and honest failures. No vendor names shipped, so no clearance needed.
- **Gated:** the preconfigured vendor catalog (founder decision 1 — counsel review) sits behind a config flag defaulting off, and its per-entry authorize-time verification status is a hand-filled field, because registration success does not prove authorize-time acceptance.

Sequenced: one-vendor spike (Linear, end to end, real grant) → OAuth machinery → multi-account + the fabricated-success fix → persistence → Google → catalog → CIMD hosting.

## Non-goals (carried or new)

- The `/connections` page redesign, catalog tiles, brand marks, and the try-it-now flow (critique P2/P4/P6 — a separate surface spec). This spec ships the mechanism and only the minimum UI honesty: real states in the existing connect dialog.
- Fixing the managed provider's throw-free `warnings[]` hole (critique P0) — same connector layer, different defect, already its own item.
- Slack. Prohibited in writing for unlisted apps; the Relay Slack adapter remains the answer and already ranks first.
- Any claim that a vendor works before a real grant has been carried against it.

## Open questions carried into SPECIFY

1. Fixed callback-port ladder vs. RFC 8252 §7.3 any-port loopback — which do real MCP auth servers honor?
2. Where does the CIMD document live on `dorkos.ai`, and what makes it stable enough to be a permanent contract?
3. How do we detect "you just signed in as the same account again" without vendor-specific code?
4. Do Google's Workspace MCP servers accept a public PKCE-only client, or do they require the (non-confidential) desktop-app client secret?
5. Attachment persistence: new table or config?
6. Does forcing a fresh vendor sign-in work at all, per vendor?
