---
slug: gate-bypass-surfaces
number: 260906-164422
created: 2026-09-06
status: ideation
---

# Routes that mount outside the session gate and the host guard

**Slug:** gate-bypass-surfaces
**Tracker:** DOR-1708
**Date:** 2026-09-06
**Author:** investigation agent (Opus)

---

## 1) Intent & Assumptions

- **Task brief.** The 2026-09-02 auth-model audit flagged three mounts that sit outside `sessionGate` and outside the DNS-rebinding `hostGuard`: the A2A gateway (`/a2a`), the `/.well-known/agent*.json` cards, and `/codex-ui-mcp`. `/codex-ui-mcp` has no auth in any posture and is currently safe only because its single tool is an inert stub — an assumption held by a comment. Decide, per surface, whether to **gate** it or to **pin** the safety assumption with tests so it cannot rot silently.
- **This document is the decision, not the code.** Each surface gets a verdict, the risk that verdict accepts, and an implementation sketch sized for a follow-up EXECUTE ticket.
- **Baseline.** Read against `origin/main` at `3245a953a` (working tree clean at start). Nothing was modified outside `specs/`.
- **Assumptions carried into the verdicts:**
  - The threat model is the repo's existing one: a **DNS-rebound browser page** and a **network peer reaching an exposed port** are in scope; a **hostile local process with loopback socket reach** is explicitly out of scope while login is off (ADR `260717-021653`, "Negative" §1 states this outright). No verdict below claims to close the local-process hole.
  - `a2a.enabled` ships **`false`** (`packages/shared/src/config-schema.ts` §`a2a`), so on a default install the A2A mounts do not exist at all. `/codex-ui-mcp` is mounted **unconditionally, on every boot**.
  - The A2A card contract (public card, optional authenticated extended card) is protocol-normal; DorkOS advertises `extendedAgentCard: false`.
- **Out of scope:** the `/mcp` auth model itself (settled by ADR `260717-021653` + ADR-0320), per-principal A2A isolation (`contextId` is documented as a shared partition key, not a boundary), the WebSocket upgrade gate (verified guarded, see §3), and any change to `hostGuard`'s own `/api` behaviour.

## 2) Pre-reading log

| File                                                                                | What it settled                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/app.ts`                                                            | Middleware ordering. `hostGuard` is mounted at **`/api` only** (L238). `sessionGate` is mounted **app-wide** (L267) but decides internally. The module doc at L59-70 already names `/a2a` as a mount `hostGuard` never sees, and argues CORS is not a gate. |
| `apps/server/src/services/core/auth/session-gate.ts`                                | `isGatedPath` = `/api/*`, `/mcp`, `/mcp/*` — and nothing else. `/codex-ui-mcp` and `/a2a` are outside it **by construction, in every posture**.                                                                                                             |
| `apps/server/src/middleware/host-guard.ts`                                          | Enforces only when login is off and `DORKOS_ALLOW_INSECURE_BIND` is unset. Reads the raw `Host`.                                                                                                                                                            |
| `apps/server/src/middleware/mcp-origin.ts`                                          | `validateMcpOrigin`: `allowNoOrigin: true`, `pairSameOriginWithHost: true`. Closes the browser rebinding path on the MCP family; **passes every non-browser caller by design**.                                                                             |
| `apps/server/src/middleware/mcp-auth.ts`                                            | The house auth model. Four acceptors, then a fail-closed default. `'a2a'`: GET open / POST gated when login is off; **both 401 when login is on**.                                                                                                          |
| `apps/server/src/services/core/auth/exposure-guard.ts`                              | `checkA2aExposure` — A2A refuses to mount on a non-loopback host unless a _network-reachable_ credential exists (`MCP_API_KEY`, legacy key, or login) or `DORKOS_ALLOW_INSECURE_BIND` is set.                                                               |
| `apps/server/src/index.ts` L2419-2470, L3095-3180                                   | The two mount sites. One shared `mcpRateLimiter` **instance** serves both `/mcp` and `/codex-ui-mcp`.                                                                                                                                                       |
| `apps/server/src/services/runtimes/codex/codex-ui-mcp-server.ts`                    | The stub. Zero-argument factory, one tool, echo-only handler.                                                                                                                                                                                               |
| `apps/server/src/services/runtimes/shared/dorkos-mcp-injection.ts`                  | `resolveMcpBearer()` returns **`null`** when login is on and `MCP_API_KEY` is unset. This is the fact that makes "just gate `/codex-ui-mcp`" expensive.                                                                                                     |
| `apps/server/src/services/runtimes/codex/dorkos-header-env.ts` + `codex-options.ts` | The existing, working machinery for handing a Codex subprocess a bearer without putting it in argv (`env_http_headers`).                                                                                                                                    |
| `apps/server/src/services/core/streams/upgrade-router.ts`                           | The WebSocket upgrade gate — origin-paired-with-host, with the exemption deliberately narrowed. Verified sound; no action.                                                                                                                                  |
| ADR `260717-021653`, ADR-0320, ADR-0103 (superseded)                                | The decided posture, including "on `/a2a` … agent-card discovery (GET) stays open".                                                                                                                                                                         |
| `contributing/api-reference.md` §"Deployment security"                              | The documented A2A exposure story, including that tunnel traffic collapses into one rate-limit bucket.                                                                                                                                                      |

## 3) Inventory — every mount outside `sessionGate` / `hostGuard`

The walk is `app.ts` top-to-bottom, then every `app.use`/`app.get` in `index.ts` that is not under `/api`, then every listener that is not the Express app at all.

| #   | Surface                                                                                                        | Mounted                         | `hostGuard`              | `sessionGate` | Origin check                                    | Auth                                                                    | Verb reach                             |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------ | ------------- | ----------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| 1   | `/a2a` (`POST /`, `POST /agents/:id`)                                                                          | only when `a2a.enabled`         | no                       | no            | **none**                                        | `createMcpAuth({surface:'a2a'})`                                        | **tool execution** — a full agent turn |
| 2   | `/a2a/agents/:id/card`                                                                                         | with #1                         | no                       | no            | **none**                                        | same; **GET open when login off**                                       | read (one agent's card)                |
| 3   | `/.well-known/agent-card.json` + `/.well-known/agent.json`                                                     | with #1                         | no                       | no            | **none**                                        | same; **GET open when login off**                                       | read (**the whole agent roster**)      |
| 4   | `/codex-ui-mcp`                                                                                                | **always**                      | no                       | no            | `validateMcpOrigin`                             | **none, in any posture**                                                | tool execution — but the tool is inert |
| 5   | Static SPA + SPA deep-link fallback                                                                            | production                      | no                       | no            | n/a                                             | none, by design                                                         | read (public bytes)                    |
| 6   | `createMockMcpOAuthRouter()` at app **root**, incl. `/.well-known/*`                                           | only when `DORKOS_TEST_RUNTIME` | no                       | no            | none                                            | none                                                                    | mock OAuth + MCP                       |
| 7   | Preview listeners on their own ports (`services/workbench-serve/preview-listener.ts`)                          | on demand                       | **not even on this app** | no            | n/a                                             | signed token → `HttpOnly` cookie; `/__dorkos_preview/health` open (204) | proxy to a local dev server            |
| 8   | WebSocket upgrades (terminal, durable streams)                                                                 | always                          | n/a                      | bypassed      | `attachUpgradeRouter` pairs origin **and** host | per-route `required` / `bearer-of-id`                                   | streams, terminal                      |
| 9   | Evals harness app (`harness-boot.ts`) — `/api/capabilities` invoke with the tier gate **unarmed**, `/api/test` | eval runs only                  | —                        | —             | —                                               | —                                                                       | not the production server              |

Rows 1-4 are the ticket's subject. Rows 5-9 are the sweep result: **rows 7, 8 and 9 are new to this ticket's framing but need no action** — each is already reasoned about in its own module doc and guarded by a mechanism appropriate to it. They are listed so the next audit recognises them instead of re-discovering them as findings. Row 6 needs no action but is worth one sentence of pin (§6, D4).

### Three facts the audit did not state, found by this sweep

**F1 — `/codex-ui-mcp` is internet-reachable, with no auth, whenever a tunnel is up — including with login ON.**
`sessionGate`'s `isGatedPath` matches `/mcp` exactly and `/mcp/` as a prefix; `/codex-ui-mcp` matches neither. `validateMcpOrigin` sets `allowNoOrigin: true` because real MCP clients send no `Origin`, so a `curl` through the tunnel passes it unconditionally — the origin check stops browsers, and only browsers. Tunnel start requires login on and an owner (`canExpose`), so the operator's mental model ("I turned login on, so my box is closed") is wrong for exactly this one path. The same is true on the LAN under `DORKOS_ALLOW_INSECURE_BIND` (both shipped Docker targets set it). The audit's phrasing — "no auth in any posture" — is true but undersells this: it is not merely ungated, it is _reachable from the internet while ungated_.

**F2 — `/mcp` and `/codex-ui-mcp` share one rate-limiter instance, so unauthenticated traffic spends the authenticated surface's budget.**
`index.ts` L2420 builds `mcpRateLimiter` once and passes the same handler to both mounts, so they share one `express-rate-limit` store. Buckets key on the TCP peer, which normally means an attacker only exhausts their own. But `contributing/api-reference.md` records that DorkOS's own tunnel runs the ngrok agent **in-process and forwards to the local port** — so every tunneled request keys to loopback and shares one bucket. Combined with F1: an internet caller can spend the operator's `/mcp` budget through the tunnel by hammering an endpoint that asks them for nothing. Denial of service, not disclosure, but concrete and free to fix.

**F3 — the "enforced by a comment, not a test" claim is half right, and the missing half is the part that matters.**
`apps/server/src/services/runtimes/codex/__tests__/codex-ui-mcp-server.test.ts` **already** pins the tool census ("exposes exactly one tool — control_ui — and never get_ui_state") and the echo shape of the stub. What nothing pins is the property those tests depend on: that the factory is **dependency-free**. `createCodexUiMcpServer()` takes zero arguments and imports only the MCP SDK, the shared UI-tool contract and a pure consent predicate. Give it a `deps` parameter and wire a service through it and every existing test still passes — the census test asserts one tool, not an _inert_ tool. That is the exact rot path, and it is the thing to pin.

## 4) Per-surface risk analysis

### `/a2a` JSON-RPC (rows 1) — already gated; no residual

Execution is token-gated in every posture: login on → 401 without a credential; login off → 401 without the local token, which is a `0600` file a remote caller cannot read. A DNS-rebound page has no token and, under login, no cookie (cookies are origin-scoped, which is the same reason `hostGuard` stands down under login). **No residual risk beyond the local-process hole already accepted by ADR `260717-021653`.**

### Agent cards (rows 2-3) — one real gap: rebinding reads the roster

What the fleet card contains (`packages/a2a-gateway/src/agent-card-generator.ts` `generateFleetCard`): every registered agent's **id, name, description, runtime and namespace**, the agent count, and the advertised `baseUrl`. Agent names and descriptions in real installs carry project, client and company names.

Reachability, posture by posture:

| Posture                                               | Card GET            | Notes                                                                                                                            |
| ----------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| login off, loopback bind (the default when A2A is on) | **open**            | ADR-decided. Any local process may read it — accepted. **And any DNS-rebound web page may read it — not previously considered.** |
| login on (the only posture where a tunnel can exist)  | **401**             | `createMcpAuth` returns 401 for GET too once `auth.enabled` is true.                                                             |
| `MCP_API_KEY` set                                     | **401**             | Same branch.                                                                                                                     |
| non-loopback bind, no credential                      | **not mounted**     | `checkA2aExposure` refuses.                                                                                                      |
| non-loopback bind + `DORKOS_ALLOW_INSECURE_BIND`      | **open to the LAN** | Warned at boot; the container owns the boundary.                                                                                 |

So the gap is precisely one cell: **a malicious page the operator visits can, via DNS rebinding, enumerate their agent roster** when A2A is enabled and login is off. It cannot execute anything. `hostGuard` would have refused it; nothing on this mount does, because `hostGuard` is `/api`-only and the A2A mount carries no origin middleware at all.

There is also a **protocol-shaped question in the other direction**: in the only posture where an external peer can reach A2A (login on, or `MCP_API_KEY`), card discovery is **401**. An A2A peer that expects to fetch `/.well-known/agent-card.json` before it holds a credential cannot bootstrap. That is defensible — the peer needs the bearer to do anything anyway — but it is a product decision, not an accident, and it is not written down anywhere. See §7, Q1.

### `/codex-ui-mcp` (row 4) — inert today, reachable from the internet, unpinned

**The stub claim verifies.** `createCodexUiMcpServer()` takes no arguments, holds no session, and registers exactly one tool whose handler returns `jsonContent({ success: true, action })` — or a refusal for an action `isUiActionRefusedOnCodex` rejects. The real effect happens downstream in the Codex event-mapper, which intercepts the resulting `mcp_tool_call` _inside the turn loop_ where a session exists. An external caller reaches the stub and never the mapper, because the mapper reads the Codex SDK's item stream, not this HTTP mount. **Calling it from outside produces no observable effect on DorkOS state.** Confirmed by reading the source and by the existing test file, which drives it through the production `createMcpRouter`.

What an unauthenticated caller gets today: `initialize` (server identity `dorkos_ui`), `tools/list` (the `control_ui` contract — a DorkOS fingerprint), an echo, and 60 requests/minute of the shared bucket (F2).

**Why gating it with `createMcpAuth` is not free.** The Codex subprocess dials this URL with **no bearer**, and `resolveMcpBearer()` in `dorkos-mcp-injection.ts` documents why one may not exist: `MCP_API_KEY` first, else `getMcpLocalToken()`, which returns `null` **when login is on**. So in the login-on-without-`MCP_API_KEY` posture there is _no credential the server could hand its own subprocess_. Putting `createMcpAuth({surface:'mcp'})` in front of this mount breaks the Codex canvas for every operator who turns login on — which is the posture the product pushes people toward. That is almost certainly why the mount was left bare, and the comment says as much ("the loopback URL threads no bearer token").

## 5) Decisions

### D1 — `/a2a` + both `/.well-known/agent*.json` + `/a2a/agents/:id/card`: **GATE, with an origin guard — not with auth**

Add the same origin-and-host pairing the MCP family already uses to the whole A2A mount. Do **not** change the auth posture: ADR `260717-021653` decided GET-open/POST-gated deliberately and this does not reopen it.

This works because the policy is already shaped for exactly this caller mix. `allowNoOrigin: true` passes every real A2A peer (an SDK client sends no `Origin`, and Node's `fetch` adds none), while `pairSameOriginWithHost: true` refuses a browser that satisfies same-origin only because it rebound DNS — the browser is forced to send `Origin` and `Host` truthfully, so it can always be judged. Net effect: the rebinding read closes, and **no legitimate A2A caller changes behaviour**.

- **Risk accepted:** a local process may still read the cards (unchanged, and explicitly accepted by the ADR). A LAN peer may still read them under `DORKOS_ALLOW_INSECURE_BIND` (unchanged; the container owns that boundary). This buys the browser case only — which is the case `hostGuard` exists for and the one nothing was covering.
- **Why not simply extend `hostGuard` to `/a2a`?** `hostGuard` has no `allowNoOrigin` concept: it judges `Host` alone, so it would refuse a legitimate external A2A peer connecting to `dorkos.example.com` unless the operator populated `DORKOS_TRUSTED_HOSTS`. That converts a security fix into a silent-outage generator for the surface's actual users. The origin-paired policy is strictly better targeted.
- **Why not require auth on the cards?** It is already required whenever the surface is remotely reachable, and requiring it on loopback too would break zero-config local A2A for no gain the origin guard does not already deliver.

### D2 — `/codex-ui-mcp`: **PIN the inertness, and take two cheap hardenings. Do not put auth on it.**

Auth is rejected on the evidence in §4: there is no bearer to present under login-on, so gating breaks canvas parity in the posture the product recommends. The stub's inertness is therefore load-bearing, and it must stop being a comment.

**The pin (required).** Three assertions, of which the third is the one that actually holds the line:

1. `expect(createCodexUiMcpServer).toHaveLength(0)` — the factory takes no dependencies. Reds the instant anyone gives the stub something to act on.
2. The existing tool census stays (already present, no work).
3. **An import allowlist over `codex-ui-mcp-server.ts`.** Read the module's own static imports and assert they are confined to `@modelcontextprotocol/sdk/*`, `../shared/ui-tool-contract.js`, `../shared/mcp-content.js` and `./ui-command-consent.js`. Any reach into `services/`, `lib/`, the DB, or a runtime reds it. This is the durable pin: importing something with a side effect is the necessary first step of every way this surface could become dangerous, so it is the right thing to make impossible-by-red.

   An ESLint `no-restricted-imports` block scoped to that one file expresses the same rule and rides `lint`, a required merge-queue check — worth doing **instead of** the test if the pattern list stays readable, since the repo already confines imports per-directory in `apps/server/eslint.config.js`. Recommend: ESLint rule as primary, test as the fixture that proves the rule (the `scripts/test-homedir-guard.sh` model).

   A mount-shape assertion — "assert `index.ts` wires no auth here" — is explicitly **not** recommended. Asserting the absence of middleware is a test that passes for the wrong reasons and breaks on unrelated refactors.

**Hardening H1 (recommended) — give it its own rate limiter.** One line: a second `buildMcpRateLimiter()` call for the `/codex-ui-mcp` mount. Closes F2 outright; costs nothing; removes the only concrete harm reachable today.

**Hardening H2 (recommended, operator's call) — mint the mount at an unguessable path.** `/codex-ui-mcp/<per-boot-random>` instead of `/codex-ui-mcp`. The composition root already **hands** the runtime this URL (`mcpUiUrl` is derived in `index.ts`, not user config, and reaches `CodexOptions.config.mcp_servers`), so the change is the mint site plus the mount string, and nothing else in the product constructs this URL. It closes F1 in every posture — tunnel, LAN, container — with no credential plumbing and no login dependency, which is exactly why it is preferable to auth here.

Be honest about what it does not do: the URL is flattened into the `codex exec` argv, so **any local process can read the secret with `ps`**. That is fine — a local process is already out of scope by ADR, and the threat this closes is the remote one. Say so in the code comment, or the next reader will over-trust it.

If the operator judges F1's residual (fingerprint + echo) too small to spend a change on, H2 can be dropped and D2's pin still satisfies the ticket. H1 should be taken regardless; it fixes a real, if minor, DoS.

### D3 — rows 5, 7, 8, 9: **no action; record them.**

The SPA must be ungated or the login screen cannot render. The preview listeners are ADR-backed (`260817-152705`), token-gated, and their one open route answers `204` and nothing else. The upgrade router pairs origin with host and narrows its own exemption more tightly than `hostGuard` does. The evals harness app is not the production server. The value here is the inventory itself: §3 is the artifact, so the next auth audit starts from a complete list instead of rediscovering row 7 as a finding.

### D4 — row 6: one-line pin, no behaviour change.

`createMockMcpOAuthRouter()` mounts at the app **root** and serves `/.well-known/*` with no auth; its only guard is `env.DORKOS_TEST_RUNTIME`. Nothing asserts that. A test that builds the app with the flag unset and expects `404` on one of its paths is two lines and makes the guard non-silent. Fold into the D2 ticket.

## 6) Implementation sketch (sized for follow-up tickets)

**Ticket A — "The A2A mount judges browser origins" (D1). Small.**

- Generalise the origin middleware. `middleware/mcp-origin.ts` is already documented as "a thin adapter, and nothing more" over `isTrustedBrowserOrigin`; the only MCP-specific thing in it is the JSON-RPC refusal body, which suits `/a2a` too (A2A _is_ JSON-RPC). Either export a `browserOriginGuard(policy)` factory from that module and have `validateMcpOrigin` be its first caller, or add a sibling `a2aOriginGuard` with the same `{ allowNoOrigin: true, pairSameOriginWithHost: true }` policy. Prefer the factory — DOR-1711's whole direction was one policy, many thin adapters.
- Wire it ahead of `a2aAuth` at all three mount sites in `index.ts` (L3168, L3169, L3172), after the rate limiters so scraping is still throttled first.
- Tests: a rebound-page request (`Origin: http://evil.example:PORT`, `Host: evil.example:PORT`) gets 403 on the fleet card, the per-agent card and the RPC POST; a no-`Origin` request still reaches the card; a genuine same-origin browser request still reaches it. Extend `middleware/__tests__/mcp-origin.test.ts` rather than starting a new file.
- Docs: one bullet under `contributing/api-reference.md` §"Deployment security".
- **Not in scope:** touching `createMcpAuth`. The GET-open/POST-gated split is ADR-settled.

**Ticket B — "The Codex UI stub cannot stop being a stub" (D2 + D4). Small.**

- ESLint: a file-scoped `no-restricted-imports` block for `services/runtimes/codex/codex-ui-mcp-server.ts` banning relative reach beyond its four allowed modules. Must be **added to**, not replace, the existing blocks in `apps/server/eslint.config.js` — flat-config options replace rather than merge, which is the trap `scripts/test-homedir-guard.sh` exists to catch. Add a sibling fixture script or a unit test that proves the new rule fires and that the prior blocks still do.
- Add the zero-arity assertion to the existing `codex-ui-mcp-server.test.ts`, with a comment naming _why_ (an external caller reaches the stub, never the event-mapper).
- H1: a second `buildMcpRateLimiter()` for the `/codex-ui-mcp` mount, with a comment naming F2.
- D4: the two-line `DORKOS_TEST_RUNTIME`-off 404 assertion for the mock OAuth router.
- Update the mount comment in `index.ts` (L2457-2462) to point at the pin instead of asserting inertness on its own authority.

**Ticket C — "The Codex UI mount is not a public endpoint" (H2). Small, gated on Q2.**

- Mint one per-boot random segment where `mcpUiUrl` is built; use the same value in the `app.use()` path.
- Comment must state the argv-visibility limit explicitly.
- Test: the bare `/codex-ui-mcp` path 404s; the minted path serves.

**Sequencing.** A and B are independent and can land in either order. C depends on nothing but should follow B so the pin exists before the surface is moved.

## 7) Open questions for the operator

- **Q1 — Must A2A discovery work for a peer that does not yet hold a credential?** Today, in every posture where an external peer can reach the gateway, `GET /.well-known/agent-card.json` returns **401** — so a peer cannot fetch the card before it has the bearer. If the intended story is "another machine points its A2A client at my DorkOS and discovers it", that story does not work today, and D1 does not change it either way. If the answer is "yes, discovery must be pre-credential", that is a separate decision about opening the card under login — and it would want the A2A spec's authenticated-extended-card split (public skeleton card, full roster behind auth) rather than simply widening the current one. **This is the one question that could change D1's scope.**
- **Q2 — Is H2 worth spending?** The residual it closes is fingerprint-plus-echo from the internet. Cheap to do, but it moves a URL that appears in Codex config and in one log line. Yes/no from the operator.
- **Q3 — Should the legacy `/.well-known/agent.json` alias be retired?** It is documented as "kept during the transition" and doubles the surface area of every decision here. Not a security question; a cleanliness one, and cheap to fold into Ticket A.

## 8) Uncertainty register

- **Verified by reading source, not by execution.** No server was booted for this investigation. The reachability claims (F1 especially) follow from middleware ordering and the two predicates' documented semantics, both of which have their own test suites — but the end-to-end "curl the tunnel and reach `/codex-ui-mcp`" has **not** been demonstrated. If the EXECUTE ticket wants proof before spending H2, that is the one experiment to run: bring a tunnel up and `curl` the path with no credential.
- **The shared-bucket claim (F2)** rests on `contributing/api-reference.md`'s statement that the in-process ngrok agent forwards to the local port. That is documentation, not code I read. The shared _limiter instance_ is code, and is certain; the tunnel-collapses-to-one-bucket half is inherited from the doc.
- **`DORKOS_PUBLIC_URL`'s reach** was not chased. It is advertised on cards, and the cards are 401 in every posture where it would be interesting, so it is almost certainly a non-issue — but "almost certainly" is the honest word.
- **Extension-registered routes** (`/api/ext/:id`) were confirmed to mount under `/api` and therefore inherit both gates. Whether an extension can register a handler that _itself_ reaches further was not investigated; it is a different question and belongs to a different ticket.
