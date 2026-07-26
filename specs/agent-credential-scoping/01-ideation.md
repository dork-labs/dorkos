# Ideation: Agent credential scoping

- **Slug:** agent-credential-scoping
- **Id:** 260725-210431
- **Date:** 2026-07-25
- **Tracker:** DOR-474 (P1), project "Agents as First-Class Operators"

## Intent

DorkOS's approval gate exists to put a person between an agent and an irreversible action. With login on, the proof that a person is present is `res.locals.user`, which `sessionGate` sets from either a browser session cookie or an API key. Nothing distinguishes a key an operator carries from a key an agent carries, so the same object proves two different things to two different authorities. An agent that holds a key can request a destructive action and then approve it.

The goal is one invariant, stated narrowly enough to be true: **the credential DorkOS gives an agent cannot decide an approval.**

## The defect, exactly

1. An agent calls a `destructive` capability. The tier gate refuses it and hands back `approvalId` plus `approvalToken` in a 202 (`tier-enforcement.ts:453-474`, `capabilities-invoke.ts:100-104`).
2. The agent calls `POST /api/approvals/<id>/grant` with `Authorization: Bearer <key>` and no `X-DorkOS-Agent` header.
3. `sessionGate` resolves a user from the key (`session-gate.ts:107-121`) and lets the request through.
4. `agentSelfApprovalRefusal` (`routes/approvals.ts:37-44`) looks for a resolved agent identity. There is none, because the caller chose not to send the header, and `resolveAgentIdentity` never rejects a request for its absence (`middleware/agent-identity.ts:11-19`).
5. The approval is granted. The agent retries with the token and the action runs.

Neither half is a mistake on its own. The CLI sending the key is a fix that had to land: without it, Codex and OpenCode agents cannot reach the operator surface at all when login is on, and the CLI is their only actuation path (`packages/cli/src/lib/api-client.ts:169-187`, `:253-262`). The header-keyed refusal is honest about what it is: it stops an agent that identifies itself. The composition is the defect.

## What is actually on the machine today (verified 2026-07-25)

Every line below was read in this worktree.

**Credentials that reach the operator surface**

| Credential                      | Set by                                                                 | What it proves today                                           |
| ------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| Better Auth session cookie      | browser sign-in; `httpOnly`, `sameSite: lax` (`auth/index.ts:141-151`) | a person is at a browser                                       |
| Better Auth API key (Bearer)    | Settings > Security > API keys (`use-api-keys.ts:41-44`)               | some holder of the owner's key                                 |
| `X-DorkOS-Agent` identity token | injected at agent spawn (`agent-token-env.ts:42-65`)                   | which agent is asking, and its `tierCeiling`. Never authorizes |
| `MCP_API_KEY` env               | deployment env (`middleware/mcp-auth.ts:66-70`)                        | `/mcp` and `/a2a` only. Never reaches `/api/approvals/*`       |

**`res.locals.user` is write-only.** It is assigned at `session-gate.ts:169` and read nowhere in `apps/server/src` outside its own module and doc comments. The approval decide handlers never look at it. So in the login-off posture there is not even a negative check: any caller that omits the identity header can decide.

**The two postures are one boolean.** `local-trust` and `signed-in-operator` are not code terms. The real switch is `config.auth.enabled`, read per request (`session-gate.ts:142`). Docs call the off state "the local trust model" (`docs/self-hosting/threat-model.mdx:63`).

**Nothing mints `<dork home>/api-key`.** The CLI reads it (`api-client.ts:152-181`) and explicitly does not create it (`commands/auth-instance.ts:68`). The operator writes it by hand, and the docs recommend exactly that, for exactly this reason:

> The key file is the better choice when your agents run `dorkos` commands themselves, because they inherit it without you exporting anything.
> (`docs/guides/cli-usage.mdx:264`)

The documented happy path hands agents a person's credential.

**The `apikey` table already has the columns.** `permissions` and `metadata` both exist in the Drizzle schema (`packages/db/src/schema/auth.ts:130-131`) and in the applied migration (`packages/db/drizzle/0022_absurd_cassandra_nova.sql:40-41`). Neither is written or read anywhere in DorkOS. No database migration is needed to carry a scope.

## What the installed Better Auth actually supports

Read from `node_modules/@better-auth/api-key@1.6.23/dist/`, not from documentation. The plugin is a separate package from `better-auth@1.6.23` and is declared at `apps/server/package.json:28`. It is configured with zero options: `plugins: [apiKey()]` (`auth/index.ts:137`).

- **`permissions`** is `Record<string, string[]>` and is **server-only at both create and update**. A call carrying `ctx.request` or `ctx.headers` (which every HTTP call from the browser does) is rejected with `SERVER_ONLY_PROPERTY` if it supplies `permissions` (`index.mjs:734-736` for create, `:1481-1487` for update). It is returned, JSON-parsed, on `verifyApiKey` (`:2009-2022`).
- **`metadata`** is gated by `enableMetadata` (default `false`, `:2266`) but is **not** server-only. Once enabled, a cookie-session client can set it at create and rewrite it through `updateApiKey`, which checks only `enableMetadata` and silently drops the field otherwise (`:1512-1515`). It also round-trips faithfully on read regardless of the flag, so a direct DB write populates it (`:2013-2022`). Metadata is therefore not an authority marker.
- **Passing a `permissions` argument to `verifyApiKey` is a trap.** When the stored permissions are null, or `role(stored).authorize(requested)` fails, it throws, and the endpoint converts that to `{ valid: false, error: { code: 'KEY_NOT_FOUND' } }` (`:1664-1668`, caught at `:1973-2008`). Every key that exists today has `permissions: null`, so using that path to assert "this key may decide" would reject every existing key.
- **An API key cannot mint an API key.** `enableSessionForAPIKeys` defaults to `false` (`:2285`), the plugin never reads `Authorization: Bearer` anywhere, and `createApiKey` requires a cookie session for any client request (`:733`, `:749-754`). An agent holding only a key cannot escalate by issuing itself a better one.

### The finding that changes the shape of this work

**Every API key the cockpit creates is rate limited to 10 verifications per rolling 24 hours.**

`apiKey()` with no options resolves `rateLimit: { enabled: true, timeWindow: 86400000, maxRequests: 10 }` (`:2270-2274`). Those values are written as concrete columns into every created row (`:826-831`). `verifyApiKey` enforces them on every call: `if (apiKey.requestCount >= rateLimitMax) return deny` (`:1609-1613`), which throws `TOO_MANY_REQUESTS` (`:1790-1794`) and is caught and returned as `{ valid: false, error: { code: 'RATE_LIMITED' } }` (`:1973-2008`). `verifyRequestAuth` sees `valid: false` and returns `null`, so `sessionGate` answers 401. The counter only resets after a full window with no request at all.

The CLI presents its key on every `/api/*` call (`api-client.ts:253-262`) and has no cookie, so every call burns one. An agent doing real operator work with login on gets roughly ten requests and then starts failing with "this DorkOS instance did not accept your API key".

The rate-limit fields are, like `permissions`, server-only at creation. So a key an agent can actually use has to be minted server-side no matter what we decide about scoping. Scoping and minting are the same piece of work.

**Status of this finding:** traced in the installed plugin source, with the citations above. Not reproduced against a running server. Reproducing it is the first task of the implementation, and if it does not reproduce, the minting rationale narrows to scoping alone (the design does not otherwise depend on it).

### A second escalation path, found while mapping the first

`operator.config_patch` is tier `act`, so it needs no approval (`operator-capabilities.ts:222-228`). `applyConfigPatch` deep-merges and validates against `UserConfigSchema` with **no write allowlist** (`config-patch.ts:123-160`). `auth.enabled` is an ordinary schema field. So any caller that reaches the capability surface can set `auth.enabled: false` and drop the whole instance into `local-trust`, where `sessionGate` is a pass-through and there is no credential left to classify.

Without closing this, every other decision in this spec is decoration.

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

| Option                                              | Verdict                                                                                                                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session cookie only. No key may ever decide         | Strictly stronger, and tempting: nothing readable from disk decides. Rejected because it forecloses a headless operator and a future `dorkos approve` verb, and buys nothing today (no CLI decide verb exists) |
| Person-scoped keys may decide, agent-scoped may not | **Yes**, with the residual limit stated plainly rather than glossed                                                                                                                                            |
| Compare requester to decider per approval           | **No.** `requestedBy` is a display label, never interpreted (`approval-service.ts:76-81`). And the interesting attacker is agent B approving agent A, which a per-approval comparison allows                   |

### Collapsing the two credentials

Merging the agent identity token into the transport credential (having `verifyRequestAuth` accept `X-DorkOS-Agent`) would give one secret per agent and make dropping it a 401.

Rejected. The property it buys applies only when login is on, and login is off by default. The property it costs applies always: ADR 260725-133220 turns on the fact that dropping a credential can never widen authority, which is true precisely because the identity token does not authorize. Collapsing inverts that. In the default posture, dropping the merged token would still reach everything and now also shed the `tierCeiling`. The credentials also disagree on lifecycle (per-spawn versus operator-managed), on verifier (the identity service versus Better Auth), and on revocation granularity (agentPath-wide versus per key). Two credentials, one seam.

## Open questions carried into the specification

1. Default for an unscoped key: person or agent? (Resolved in the spec: person.)
2. Does anything need a config field, and therefore a migration? (Resolved in the spec: no.)
3. What does the conformance probe prove, and what does it not? (Resolved in the spec, deliberately narrow.)
