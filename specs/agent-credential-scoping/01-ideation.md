# Ideation: Agent credential scoping

- **Slug:** agent-credential-scoping
- **Id:** 260725-210431
- **Date:** 2026-07-25
- **Re-verified:** 2026-07-27 against `origin/main` (see "What changed since 2026-07-25")
- **Tracker:** DOR-474 (P1), project "Agents as First-Class Operators"

## Intent

DorkOS's approval gate exists to put a person between an agent and an irreversible action. With login on, the proof that a person is present is `res.locals.user`, which `sessionGate` sets from either a browser session cookie or an API key. Nothing distinguishes a key an operator carries from a key an agent carries, so the same object proves two different things to two different authorities. An agent that holds a key can request a destructive action and then approve it.

The goal is one invariant, stated narrowly enough to be true: **the credential DorkOS gives an agent cannot decide an approval.**

## The defect, exactly

Line numbers below are `origin/main` as of 2026-07-27. The chain was re-read end to end on that date and it still composes.

1. An agent calls a `destructive` capability. The tier gate refuses it and hands back `approvalId` plus `approvalToken` in a 202 (`tier-enforcement.ts:821-833`, `routes/capabilities-invoke.ts:96-108`).
2. The agent calls `POST /api/approvals/<id>/grant` (`routes/approvals.ts:356`) with `Authorization: Bearer <key>`, no `X-DorkOS-Agent` header, no `X-DorkOS-Approval` header, and no `standing: true` in the body.
3. `sessionGate` resolves a user from the key and attaches `{ userId, credential: 'api-key' }` to `res.locals.user` (`session-gate.ts:128-132`, `:187`).
4. `readCallerAuthority` reports `agentIdentityPresented: false` and `approvalTokenPresented: false`, because both read headers the caller chose to omit (`lib/caller-authority.ts:66-75`).
5. `resolveDecisionAuthority` clears all three of its refusals: no agent header (`decision-authority.ts:152`), no approval token (`:163`), login is on and a user is present (`:180`). It returns `{ allowed: true, posture: 'signed-in-operator' }` (`:189`).
6. The approval is granted. The agent retries with the token and the action runs. The Activity line says "A signed-in account (`<userId>`) granted an approval", which is true and is the only trace.

Neither half is a mistake on its own. The CLI sending the key is a fix that had to land: without it, Codex and OpenCode agents cannot reach the operator surface at all when login is on, and the CLI is their only actuation path (`packages/cli/src/lib/api-client.ts:169-186`, `:248`). The header-keyed refusal is honest about what it is: it stops an agent that identifies itself. The composition is the defect.

## What changed since 2026-07-25

Six PRs landed between this document being written and 2026-07-27, and they moved ground this document stands on. What follows replaces the corresponding claims below; the rest of the document was re-checked and still holds.

| Shipped                                                                                                                                             | What it does to this document                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#465 (DOR-428)** replaced `agentSelfApprovalRefusal` with `resolveDecisionAuthority`                                                              | The decide-side check moved and got better. It now refuses an agent header and an approval token in **both** postures, and requires an authenticated user under login-on. It does not look at credential kind, which is exactly the hole left             |
| **#469 (DOR-488)** added `config-write-policy.ts`, a per-field write allowlist with a drift guard                                                   | The "second escalation path" below is **closed**. `auth.enabled` is `operator-only` and `operator.config_patch` refuses it                                                                                                                                |
| **#476 (DOR-467)** moved the gate inside `registry.invoke`, added `lib/caller-authority.ts`, and put the write allowlist on `PATCH /api/config` too | Closes the REST twin of the same escalation. Also replaced `GATED_ADAPTER_PATHS` / `checkDestructiveGateConformance` with a registry-derived `checkRegistryGateConformance`, so the conformance pattern this document points at no longer exists as named |
| **#486 (DOR-505)** added `requireOperatorCookieUnderLogin`, and `RequestUser.credential`                                                            | Under login-on, an API key can no longer write any `operator-only` config path. It also means **half of §3.2's proposal is already shipped**: `RequestUser` carries `credential: 'cookie' \| 'api-key'` today. Only the person-or-agent axis is missing   |
| **DOR-501** shipped standing permissions, whose creation requires a session cookie (`routes/approvals.ts:382`)                                      | An agent-held key cannot open a standing permission. It can still grant a **one-time** approval, which is the live defect                                                                                                                                 |
| **DOR-520** shipped the monotonic posture floor (`approvals.standingGrantsVoidBefore`)                                                              | No effect on this document, listed so the absence is deliberate                                                                                                                                                                                           |

**What is still open, in one sentence:** with login on, a caller holding any valid API key can grant or deny a one-time approval, and DorkOS has no way to tell a key it minted for an agent from a key the operator carries.

## What is actually on the machine today (verified 2026-07-25, re-verified 2026-07-27)

**Credentials that reach the operator surface**

| Credential                      | Set by                                                                 | What it proves today                                           |
| ------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| Better Auth session cookie      | browser sign-in; `httpOnly`, `sameSite: lax` (`auth/index.ts:144-149`) | a person is at a browser                                       |
| Better Auth API key (Bearer)    | Settings > Security > API keys (`use-api-keys.ts:41-44`)               | some holder of the owner's key                                 |
| `X-DorkOS-Agent` identity token | injected at agent spawn (`agent-token-env.ts:42-65`)                   | which agent is asking, and its `tierCeiling`. Never authorizes |
| `MCP_API_KEY` env               | deployment env (`middleware/mcp-auth.ts:59-61`)                        | `/mcp` and `/a2a` only. Never reaches `/api/approvals/*`       |

**`res.locals.user` is read, and it already says which credential proved the request.** The original version of this document said it was write-only. That was true on 2026-07-25 and is false now. It is assigned at `session-gate.ts:187` and read at `lib/caller-authority.ts:67` and `:206` and at `routes/room-caller.ts:63`. `RequestUser` also gained a required `credential: 'cookie' | 'api-key'` field (`session-gate.ts:40-56`), added by DOR-505 for exactly the reason this document argues from: a per-user API key satisfies the gate the way a browser session does, and some writes need to tell them apart. The person-or-agent axis is the part that is still missing.

**The two postures are one boolean, but they are code terms now.** `DecisionPosture` is a real type with the members `signed-in-operator` and `local-trust` (`decision-authority.ts:71`). The switch underneath is still `config.auth.enabled`, read per request (`session-gate.ts:160`). Docs call the off state "the local trust model" (`docs/self-hosting/threat-model.mdx:63`).

**Nothing mints `<dork home>/api-key`.** The CLI reads it (`api-client.ts:154`, `:169`) and does not create it. The operator writes it by hand, and the docs recommend exactly that, for exactly this reason:

> The key file is the better choice when your agents run `dorkos` commands themselves, because they inherit it without you exporting anything.
> (`docs/guides/cli-usage.mdx:273`)

The documented happy path hands agents a person's credential.

**The `apikey` table already has the columns.** `permissions` and `metadata` both exist in the Drizzle schema (`packages/db/src/schema/auth.ts:130-131`) and in the applied migration (`packages/db/drizzle/0022_absurd_cassandra_nova.sql:40-41`). Neither is written or read anywhere in DorkOS. No database migration is needed to carry a scope.

## What the installed Better Auth actually supports

Read from `node_modules/@better-auth/api-key@1.6.23/dist/`, not from documentation. The plugin is a separate package from `better-auth@1.6.23` and is declared at `apps/server/package.json:29`. It is configured with zero options: `plugins: [apiKey()]` (`auth/index.ts:138`). Still 1.6.23 on 2026-07-27, and every claim in this section was re-read in the installed source on that date.

- **`permissions`** is `Record<string, string[]>` and is **server-only at both create and update**. A call carrying `ctx.request` or `ctx.headers` (which every HTTP call from the browser does) is rejected with `SERVER_ONLY_PROPERTY` if it supplies `permissions` (`index.mjs:734-736` for create, `:1481-1487` for update). It is returned, JSON-parsed, on `verifyApiKey` (`:2009-2022`).
- **`metadata`** is gated by `enableMetadata` (default `false`, `:2266`) but is **not** server-only. Once enabled, a cookie-session client can set it at create and rewrite it through `updateApiKey`, which checks only `enableMetadata` and silently drops the field otherwise (`:1512-1515`). It also round-trips faithfully on read regardless of the flag, so a direct DB write populates it (`:2013-2022`). Metadata is therefore not an authority marker.
- **Passing a `permissions` argument to `verifyApiKey` is a trap.** When the stored permissions are null, or `role(stored).authorize(requested)` fails, it throws, and the endpoint converts that to `{ valid: false, error: { code: 'KEY_NOT_FOUND' } }` (`:1664-1668`, caught at `:1973-2008`). Every key that exists today has `permissions: null`, so using that path to assert "this key may decide" would reject every existing key.
- **An API key cannot mint an API key.** `enableSessionForAPIKeys` defaults to `false` (`:2285`), the plugin never reads `Authorization: Bearer` anywhere, and `createApiKey` requires a cookie session for any client request (`:733`, `:749-754`). An agent holding only a key cannot escalate by issuing itself a better one.
- **`expiresIn` is in SECONDS, and caps at 365 days.** The plugin divides it by `3600 * 24` to get days and rejects anything above `maxExpiresIn`, which defaults to 365 (`:785-791`, defaults at `:2278-2279`). Passing a milliseconds value throws `EXPIRES_IN_IS_TOO_LARGE`. It is also **absolute**: written once at create (`:821`), compared to `Date.now()` on every verify (`:1636-1637`), never refreshed by use, and the key is deleted when it lapses. So it cannot mirror the identity token's sliding idle window. §3.4 of the specification originally passed `TOKEN_IDLE_TTL_MS`, which is wrong on both counts: wrong unit, so every mint would fail, and wrong clock, so a corrected 7-day value would still strand a continuously-working agent at day 7.

### The finding that changes the shape of this work

**Every API key the cockpit creates is rate limited to 10 verifications per rolling 24 hours.**

`apiKey()` with no options resolves `rateLimit: { enabled: true, timeWindow: 86400000, maxRequests: 10 }` (`:2270-2274`). Those values are written as concrete columns into every created row (`:826-831`). `verifyApiKey` enforces them on every call: `if (apiKey.requestCount >= rateLimitMax) return deny` (`:1609-1613`), which throws `TOO_MANY_REQUESTS` (`:1790-1794`) and is caught and returned as `{ valid: false, error: { code: 'RATE_LIMITED' } }` (`:1973-2008`). `verifyRequestAuth` sees `valid: false` and returns `null`, so `sessionGate` answers 401. The counter only resets after a full window with no request at all.

The CLI presents its key on every `/api/*` call (`api-client.ts:186`, merged into every request at `:248`) and has no cookie, so every call burns one. An agent doing real operator work with login on gets roughly ten requests and then starts failing with "this DorkOS instance did not accept your API key".

The rate-limit fields are, like `permissions`, server-only at creation. So a key an agent can actually use has to be minted server-side no matter what we decide about scoping. Scoping and minting are the same piece of work.

**Status of this finding:** traced in the installed plugin source, with the citations above. Not reproduced against a running server. Reproducing it is the first task of the implementation, and if it does not reproduce, the minting rationale narrows to scoping alone (the design does not otherwise depend on it).

### A second escalation path, found while mapping the first, and since closed

**This is fixed. Kept because the reasoning still explains why the rest of the work is worth doing.**

What this document originally found: `operator.config_patch` is tier `act`, so it needs no approval (`operator-capabilities.ts:222`). `applyConfigPatch` deep-merged and validated against `UserConfigSchema` with no write allowlist. `auth.enabled` is an ordinary schema field. So any caller that reached the capability surface could set `auth.enabled: false`, drop the instance into `local-trust`, and make every credential check unreachable.

Three PRs closed it, in this order:

1. **#469 (DOR-488)** added `services/core/operator/config-write-policy.ts`: every leaf of `UserConfigSchema` is classified `agent-writable` or `operator-only`, `auth.enabled` is `operator-only`, and a drift guard in `__tests__/config-write-policy.test.ts` fails the build when a new config field has no verdict. `createConfigPatchHandler` refuses a patch touching any of them.
2. **#476 (DOR-467)** found the REST twin: `PATCH /api/config` reached the same `applyConfigPatch` with no policy check at all. It now runs `findOperatorOnlyPaths` too (`routes/config.ts:253`).
3. **#486 (DOR-505)** added the cookie bar. Under login-on, an `operator-only` write needs `res.locals.user.credential === 'cookie'` (`lib/caller-authority.ts:199-213`, wired at `routes/config.ts:286`). This is the one that matters here: the agent bar alone is cleared by omitting a header, so before it, a minted agent key could still have turned login off through the REST route.

The residual, which those PRs state plainly and this document repeats rather than glosses: with login **off** there is no cookie for anyone, so the cookie bar allows and only the agent bar is left. A program on the machine that omits its agent header can still write every `operator-only` setting. That is scoped out here for the same reason §3.7 of the specification scopes out `local-trust` generally.

## Options considered

### Where the scope lives

| Option                                                                 | Verdict                                                                                                                                              |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata` flag                                                        | **No.** Not server-only. A cookie-session caller can rewrite it (`:1512-1515`), and it round-trips from a direct DB write regardless of the gate     |
| `permissions`, checked via `verifyApiKey`'s own `permissions` argument | **No.** Rejects every null-permission key with `KEY_NOT_FOUND` (`:1664-1668`), which is every key that exists today                                  |
| `permissions`, read back and classified by DorkOS                      | **Yes.** The one per-key field the plugin refuses to let a browser client write, at create and at update. DorkOS owns the JSON shape and the meaning |
| A second `configId` namespace                                          | **No.** Verification would have to try each configuration, changing the hot path in `verifyRequestAuth` for no property the above does not give      |
| A DorkOS-side table keyed on key id                                    | **No.** A second source of truth for one boolean, on a row Better Auth already owns and can delete                                                   |

### Where the person check lives

| Option                                              | Verdict                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session cookie only. No key may ever decide         | Strictly stronger, and tempting: nothing readable from disk decides. Rejected because it forecloses a headless operator and a future `dorkos approve` verb, and buys nothing today (no CLI decide verb exists)                                                                                  |
| Person-scoped keys may decide, agent-scoped may not | **Yes**, with the residual limit stated plainly rather than glossed                                                                                                                                                                                                                             |
| Compare requester to decider per approval           | **No.** `requestedBy` is a display label (`approval-service.ts:126-135`); the interpretable `requestedByPath` beside it names the agent, not the credential, so it cannot identify a decider. And the interesting attacker is agent B approving agent A, which a per-approval comparison allows |

**The first row got weaker after this table was written, and that should be said.** Between 2026-07-25 and 2026-07-27 the repo adopted "a cookie, or nothing" twice, for the two effects it judged strongest: opening a standing permission (`routes/approvals.ts:382`) and writing any `operator-only` setting under login-on (`routes/config.ts:286`). Both go through `requireOperatorCookieUnderLogin`. So "no key may ever decide" is no longer a novel bar, it is the house pattern, and the cost of adopting it is one function call rather than a new mechanism.

**Dorian resolved this on 2026-07-27: cookie-only ships first, scoping follows as phase 2.** The reason the first row lost is not that its argument was wrong but that its cost turned out to be zero: every first-party client already sends a cookie, so nothing breaks. The second row is not abandoned, only sequenced behind it, because a headless operator and a `dorkos approve` verb still need it. Full reasoning and three caveats in the specification's Open Questions.

### Collapsing the two credentials

Merging the agent identity token into the transport credential (having `verifyRequestAuth` accept `X-DorkOS-Agent`) would give one secret per agent and make dropping it a 401.

Rejected. The property it buys applies only when login is on, and login is off by default. The property it costs applies always: ADR 260725-133220 turns on the fact that dropping a credential can never widen authority, which is true precisely because the identity token does not authorize. Collapsing inverts that. In the default posture, dropping the merged token would still reach everything and now also shed the `tierCeiling`. The credentials also disagree on lifecycle (per-spawn versus operator-managed), on verifier (the identity service versus Better Auth), and on revocation granularity (agentPath-wide versus per key). Two credentials, one seam.

## Open questions carried into the specification

1. Default for an unscoped key: person or agent? (Resolved in the spec: person.)
2. Does anything need a config field, and therefore a migration? (Resolved in the spec: no.)
3. What does the conformance probe prove, and what does it not? (Resolved in the spec, deliberately narrow.)
4. Which agent runtimes get a minted key? (Open. `resolveAgentTokenEnv` has two production call sites on 2026-07-27, `claude-code/messaging/message-sender.ts:399` and `codex/codex-runtime.ts:484`. Nothing under `runtimes/opencode/` calls it, so an OpenCode agent has no identity token today and would get no key either. OpenCode is named in this document's own premise, so the seam has to grow a third call site or the premise has to shrink.)
5. Scope the key, or require a cookie to decide? (Reopened by the two cookie bars that shipped after this table was written, then **resolved 2026-07-27: both, in that order.** The cookie bar closes DOR-474 now; scoping is phase 2. See the specification's Open Questions.)
