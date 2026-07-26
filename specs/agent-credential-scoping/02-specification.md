---
slug: agent-credential-scoping
id: 260725-210431
created: 2026-07-25
status: specified
---

# Agent credential scoping - a key an agent holds cannot approve what an agent asked for

**Status:** Proposed
**Author:** Claude (directed by Dorian)
**Date:** 2026-07-25
**Tracker:** DOR-474 (P1), project "Agents as First-Class Operators"

## Overview

Give an API key a scope, so DorkOS can tell a credential it issued to an agent from a credential a person carries, and refuse the agent-scoped one at the approval decide routes. DorkOS mints the agent-scoped key itself at the same seam that already mints the agent identity token, which also fixes a shipped defect: a cockpit-created key is capped at ten verifications a day, so the CLI credential path an agent depends on stops working almost immediately when login is on. The scope lives in Better Auth's `permissions` column, which is the only per-key field the plugin refuses to let a browser client write. In the same change, the capability surface loses the ability to write `auth.*`, because a tool that can turn login off can undo every other line of this spec.

Scoped entirely to the `signed-in-operator` posture (`auth.enabled: true`). Section 3.7 says why, and says what is still not true afterwards.

## Background / Problem Statement

The approval primitive (spec `agent-trust` §3.3) exists so a person stands between an agent and an irreversible action. ADR 260725-133220 established that the action's tier decides the gate and identity only narrows it, so an agent cannot slip past by dropping its identity header on the way in. On the way out, the same trick still works.

An agent calls a destructive capability, receives `approvalId` and `approvalToken` in the 202 (`tier-enforcement.ts:453-474`, `routes/capabilities-invoke.ts:100-104`), then calls `POST /api/approvals/:id/grant` with `Authorization: Bearer <key>` and no `X-DorkOS-Agent` header. `sessionGate` resolves a user from the key (`session-gate.ts:107-121`). The only decide-side check reads the identity header the caller chose to omit (`routes/approvals.ts:37-44`, `middleware/agent-identity.ts:11-19`). The approval is granted by the thing that asked for it.

The key is in the agent's hands legitimately. `packages/cli/src/lib/api-client.ts:169-187` reads it from `DORKOS_API_KEY` or `<dork home>/api-key` and attaches it to every call (`:253-262`), which is required: without it Codex and OpenCode agents cannot reach the operator surface at all when login is on. `docs/guides/cli-usage.mdx:264` recommends the key file specifically because agents inherit it. Nothing on the machine mints that file; the operator writes their own key into it by hand (`packages/cli/src/commands/auth-instance.ts:68`).

So the credential is the same object for two authorities: "may this request reach the API" and "is a person present". This spec separates them.

## Goals

- With login on, a credential DorkOS minted for an agent is refused at `POST /api/approvals/:id/grant|deny`, whether or not it also presents an identity header, and the approval is left pending.
- An agent DorkOS spawns receives its own API key, so the operator never has a reason to put their personal key where an agent can read it.
- An agent's key works for the whole operator surface at real usage volumes, not for ten calls a day.
- `auth.enabled` is not writable from the capability surface, in either posture.
- The invariant is falsifiable: a named conformance probe fails if a later change re-opens the path, and the probe's doc says exactly what it proves and what it does not.
- Nothing regresses for an agent that works today. The CLI fix stands.

## Non-Goals

- Fixing the `local-trust` posture. Login off is the default and a credential-free caller with shell access is indistinguishable from the cockpit. See §3.7.
- Preventing an agent from stealing a person's credential off the machine it shares with them. See §3.7.
- Per-capability permissions on a key. The tier gate already decides what may run; scope decides only who may decide.
- Retiring the `X-DorkOS-Agent` header check. It stays as the honest-caller check, alongside the new one.
- Replacing the agent identity token with the API key, or the reverse (§3.5).
- A `dorkos approve` CLI verb. None exists today; §3.3 leaves room for one.
- Any change to `MCP_API_KEY` or the local MCP token (`middleware/mcp-auth.ts:66-70`, `:87+`). Neither is accepted by `sessionGate`, so neither can reach `/api/approvals/*`.

## Technical Dependencies

Internal only. `@better-auth/api-key@1.6.23` (declared `^1.6.23` at `apps/server/package.json:28`), configured as `apiKey()` with zero options at `apps/server/src/services/core/auth/index.ts:137`. The `apikey.permissions` column already exists in the Drizzle schema (`packages/db/src/schema/auth.ts:130`) and the applied migration (`packages/db/drizzle/0022_absurd_cassandra_nova.sql:40`), so no database migration is required. Also: `verifyRequestAuth` / `sessionGate` (`services/core/auth/session-gate.ts`), the agent-identity spawn seam (`services/core/agent-identity/agent-token-env.ts:42-65`), the approvals routes and service, `applyConfigPatch` (`services/core/operator/config-patch.ts`), and `packages/test-utils/src/capability-conformance.ts`.

## Detailed Design

### 3.1 The authority model

Three authorities exist today. Naming them is most of the design.

| Authority                      | Enforced at                                             | Credentials that may exercise it (after this spec)                                                                                |
| ------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Reach the operator surface** | `sessionGate` (`session-gate.ts:139-175`)               | session cookie, person-scoped key, agent-scoped key                                                                               |
| **Invoke a capability**        | `enforceCapabilityTier` (`tier-enforcement.ts:405-495`) | any credential that reached the surface; `destructive` stops for an approval regardless of credential kind, per ADR 260725-133220 |
| **Decide an approval**         | `routes/approvals.ts:85-119`                            | session cookie, person-scoped key. **Never an agent-scoped key**                                                                  |

The invariant, stated so it is checkable rather than aspirational:

> **A credential DorkOS issues to an agent may request a destructive action and may never decide one.**

The stronger-sounding form ("a credential that can request must not approve") is false as written, because a person's own credential can do both, and that is correct: a person approving their own request is what an approval is. The scoping question is only whether the requester is a person.

Credential kind is not the same axis as ownership. Every key is owned by the same user (registration is owner-only, `auth/index.ts:152-180`), so `referenceId` can never carry this distinction. That is why it needs a field of its own.

### 3.2 The scope marker

The scope lives in the Better Auth `permissions` column, as a DorkOS-owned JSON object.

```jsonc
// An agent-scoped key
{ "dorkos": ["agent"], "agentPath": ["/Users/dev/agents/dorkbot"] }

// A person-scoped key
null
```

`permissions` is chosen over `metadata` because it is the only per-key field the plugin refuses to let a cookie-session client write, at both create (`index.mjs:734-736`) and update (`index.mjs:1481-1487`). `metadata` is gated by `enableMetadata` alone, is client-writable once that flag is on, and is silently ignored rather than rejected when it is off (`index.mjs:1512-1515`). An authority marker a browser session can rewrite is not an authority marker.

DorkOS never passes a `permissions` argument to `verifyApiKey`. That path throws (and returns `{ valid: false, code: 'KEY_NOT_FOUND' }`) for any key whose stored permissions are null (`index.mjs:1664-1668`), which is every key on every existing install. Instead `verifyRequestAuth` reads the parsed `permissions` back off the verify result (`index.mjs:2009-2022`) and classifies it in DorkOS code, against a Zod schema in `@dorkos/shared`. The classification is ours, so it is readable, testable, and does not depend on `role().authorize()` semantics.

Classification, in `services/core/auth/api-key-scope.ts`:

| Stored `permissions`                     | Scope    | Why                                                                                                                             |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `null`                                   | `person` | Every key created by the cockpit or seeded from the legacy MCP key. See §3.6                                                    |
| Parses, and `dorkos` includes `"agent"`  | `agent`  | The shape DorkOS writes at §3.4                                                                                                 |
| Non-null and does not parse as the above | `agent`  | Only a server-side write can produce non-null permissions, so an unrecognized value is version skew or a hand edit. Fail closed |

`RequestUser` (`session-gate.ts:40-43`) gains two fields:

```ts
export interface RequestUser {
  userId: string;
  /** Which credential proved this request. A cookie always means a person at a browser. */
  credential: 'session' | 'api-key';
  /** Whether the credential belongs to a person or to an agent DorkOS spawned. */
  scope: 'person' | 'agent';
}
```

A session cookie is always `{ credential: 'session', scope: 'person' }`. Better Auth cookies are `httpOnly` (`auth/index.ts:141-151`), so a cookie is the closest thing DorkOS has to evidence that a person is at a keyboard. The addition is purely additive: `res.locals.user` is currently written at `session-gate.ts:169` and read nowhere else in `apps/server/src`, and the other consumer of `verifyRequestAuth` (`middleware/mcp-auth.ts:73-77`) only tests truthiness.

### 3.3 Refusing the decision

`agentSelfApprovalRefusal` (`routes/approvals.ts:37-44`) grows a second reason, and keeps the first:

1. The caller presents a resolved agent identity. (Unchanged. Weak by construction, since the caller chooses whether to send the header, and still worth keeping: it is what stops an honest agent, and it is what makes the log honest.)
2. `res.locals.user?.scope === 'agent'`. (New. The load-bearing check, because the server issued that credential and the caller cannot choose not to present it and still get through `sessionGate`.)

Both answer `403 AGENT_CANNOT_DECIDE` before touching `ApprovalService`, so a refused decision never consumes, expires, or otherwise disturbs the approval. It stays pending for the person it was always waiting on.

The error message stays the one already there ("Approvals are decided by a person in DorkOS, not by an agent"), because from the caller's side both reasons mean the same thing and the distinction is a log detail, not the agent's business.

If an approvals capability or MCP tool is ever added, it inherits this check and must be added to the named list in §3.8. There is no such surface today: `packages/cli/src` contains no approvals command, and no capability projects onto the approval routes.

### 3.4 Minting an agent's key

Today nothing mints `<dork home>/api-key`. DorkOS starts doing so, at the seam that already hands an agent its identity.

`resolveAgentTokenEnv(agentPath, displayName)` (`agent-token-env.ts:42-65`) currently returns `{ DORKOS_AGENT_TOKEN }`. It gains a sibling that, **only when `configManager.get('auth')?.enabled === true`**, also returns `DORKOS_API_KEY`. With login off nothing is minted, because nothing is needed.

The key is created by a headless server-side call: `auth.api.createApiKey({ body: { ... } })` with **no `headers` argument**. That is what makes the server-only fields writable (`index.mjs:734-736` rejects them for any call carrying `ctx.request` or `ctx.headers`), and it is the only way to set any of the four fields that matter:

| Field              | Value                                             | Why                                                                                             |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `permissions`      | `{ dorkos: ['agent'], agentPath: [<agentPath>] }` | The scope (§3.2). Server-only, which is the whole point                                         |
| `rateLimitEnabled` | `false`                                           | The plugin default is 10 requests per rolling day and it is enforced on every verify. See below |
| `userId`           | the owner's id                                    | Allowed only on a headless call (`index.mjs:736`); there is no session to infer it from         |
| `expiresIn`        | `TOKEN_IDLE_TTL_MS` (7 days)                      | Matches the identity token minted beside it, so the two credentials age out together            |

Also `name: "Agent: <displayName or agentPath>"`, so the key is legible in Settings > Security.

**On the rate limit.** `apiKey()` with no options resolves `rateLimit: { enabled: true, timeWindow: 86400000, maxRequests: 10 }` (`index.mjs:2270-2274`), writes those as concrete columns on every created key (`index.mjs:826-831`), and enforces them on every `verifyApiKey` (`index.mjs:1609-1613`, `:1790-1794`), which `verifyRequestAuth` sees as `valid: false` and turns into a 401. The CLI presents its key on every call and holds no cookie, so every call burns one. This is a shipped defect independent of scoping: an agent using the CLI with login on gets about ten requests and then starts failing. Traced in the installed plugin source, **not reproduced against a running server** - reproducing it is task 1 (§Implementation Phases), and if it does not reproduce, `rateLimitEnabled: false` is still correct for an agent key and nothing else in this spec changes.

The plugin returns the key material exactly once. It goes straight into the spawned child's environment and is never written to disk and never logged. It joins `DORKOS_AGENT_TOKEN` in the redaction fixtures (the invariant ADR 260725-152018 carries forward from 260723-013236).

**Lifecycle.** One key per spawn, matching the identity token's per-spawn lifecycle exactly rather than inventing a second one. Reuse across spawns would require persisting the plaintext, which is worse than an extra row. Rows are bounded by `expiresIn` and cleaned two ways: `AgentIdentityService.revoke(agentPath)` (`agent-identity-service.ts:320-339`) also revokes that agent's keys, and a sweep of expired agent-scoped keys rides the same maintenance cadence approvals already use.

**Failure is not fatal.** If minting fails, the spawn proceeds without `DORKOS_API_KEY`, logged at warn. The agent then behaves exactly as it does today: it either finds a key the operator placed, or it gets the existing actionable 401 message (`api-client.ts:200-212`). Minting must never be able to stop an agent from starting.

### 3.5 Why two credentials, and not one

An agent spawned by DorkOS with login on now carries two secrets. That is a real cost and it needs a reason.

They answer different questions, and they disagree on what absence means. The API key answers "may this request reach the API": absent, with login on, the answer is 401. The identity token answers "who is asking and what is their ceiling": absent, the answer is "unattributed", and the request proceeds. That asymmetry is deliberate and load-bearing. ADR 260725-133220 turns on it: the tier gate keys on the action's tier and never on whether the caller identified itself, precisely so that dropping the identity token cannot widen what a caller may do.

Collapsing them means making the identity token authorizing. In the login-on posture that would be a small gain (dropping it 401s). In the login-off posture, which is the default, it is a loss: dropping it still reaches everything, and now also sheds the `tierCeiling`. The credentials also disagree on verifier (Better Auth versus `AgentIdentityService`), on revocation granularity (per key versus agentPath-wide), and on applicability (the identity token matters in both postures, the key only in one).

They are not collapsed. They are co-located: minted together at one seam, expiring together, revoked together. The operator sees one thing happen.

This decision would be worth revisiting if login-on ever became the default posture, at which point the identity token's login-off role disappears and the argument changes.

### 3.6 Migration: an unscoped key is a person's key

Every key on every existing install has `permissions: null`, including the row `seedLegacyMcpApiKey` inserts directly through Drizzle (`seed-legacy-mcp-key.ts:84-98`). Those all classify as `person`.

The alternative was considered and rejected. Treating an unscoped legacy key as agent-scoped would close the hole for existing keys, at the cost of silently taking the deciding authority away from a credential an operator already relies on: a person whose CLI holds a key, on an instance with login on, would find approvals refusing them with an error that blames an agent. A security change a person cannot debug is not one they will keep.

Person-scoped is chosen because the hole it leaves is narrower than it looks. The hole is not "an agent can decide"; it is "an agent that has been handed the operator's own key can decide". §3.4 removes the reason to hand it over, and the docs change (§Documentation) removes the instruction to. Reclassifying keys the operator made for themselves is the wrong tool for a problem caused by what we told them to do with those keys.

**What the operator must do.** Nothing, for correctness. Everything below is recommended and surfaced in the release note:

1. After upgrading, agents DorkOS spawns get their own key automatically. Stop putting a personal key in `~/.dork/api-key` for their benefit.
2. If you created a key only so agents could use it, revoke it in Settings > Security. The list now labels which keys are agent-scoped, so the ones that are not are the ones only you should hold.
3. Keep using `DORKOS_API_KEY` or `~/.dork/api-key` for your own shell. That is still the supported path for a person at a terminal.

The Security panel (`apps/client/src/layers/features/auth/ui/ApiKeysSection.tsx`) gains a scope label on each key. Agent-scoped keys are shown, not hidden, with the agent they belong to, and can be revoked. They cannot be created there: `permissions` is server-only, so the browser form physically cannot mint one, which is the correct affordance rather than a rule we have to enforce. (`listApiKeys` parses and returns `permissions` at `index.mjs:1323`; confirm the client SDK's response type surfaces it before relying on it, and add a small server projection if it does not.)

### 3.7 Scope, and what is still not true

**This spec applies only when `auth.enabled` is `true`.** With login off, `sessionGate` is a zero-overhead pass-through (`session-gate.ts:142-145`), no `res.locals.user` is ever set, and there is no credential to classify. A caller with shell access and no credential is indistinguishable from the cockpit, and there is no check that could tell them apart. A prior round considered and deliberately rejected an `Origin` / `Sec-Fetch` check for exactly this reason: those headers are set by browsers as a convenience, not withheld from anything else, and a check a caller can satisfy by typing it is not a security control. Nothing here revisits that.

Only §3.9 (the posture lock) applies in both postures, and it applies there because it is not a credential check at all.

**Even with login on, this does not stop a determined agent that shares an OS user with the operator.** Such an agent can read `~/.dork/api-key` off disk and `DORKOS_API_KEY` out of the environment of any process it can inspect. Scoping does not make that impossible. What it does:

- The default path stops handing agents a deciding credential, so the common case is correct rather than correct-if-configured-carefully.
- Self-approval stops being the intended flow and becomes an act of deliberate credential theft, which leaves an audit trail: the approval card names an agent as the requester (§3.10) and the decision arrives on a credential the operator can see was theirs.
- The invariant becomes stated and testable, so a later change that re-opens the path fails a named check instead of passing silently.

Making it actually impossible requires OS-level isolation, which is what the Docker eval tier does (ADR 260725-133222) and what a sandboxed-agent story would have to do. That is not this spec, and no part of this spec should be described as delivering it.

### 3.8 Falsifiability

`packages/test-utils/src/capability-conformance.ts` already proves the request half of the gate: `GATED_ADAPTER_PATHS` (`:81-88`) names six paths (three adapters, identified and anonymous) and `checkDestructiveGateConformance` (`:453-489`) requires a probe for each, where a missing probe is itself a violation. There is no `ApprovalDecisionProbe` today; the decide half is unproven.

The decide half joins the same file rather than a new one, because the two halves are one gate: someone adding a surface should hit both lists in the same place.

```ts
/**
 * Every credential a caller can present to the approval decide routes, and
 * therefore every credential whose decide outcome must be pinned.
 *
 * Named rather than counted, for the same reason as GATED_ADAPTER_PATHS: adding
 * a credential kind without pinning what it may decide should be impossible to
 * do quietly.
 */
export const DECIDING_CREDENTIALS = [
  'session-cookie',
  'person-api-key',
  'agent-api-key',
  'agent-api-key-without-identity-header',
  'no-credential',
] as const;

/** What the decide route did when handed one credential, with login on. */
export interface ApprovalDecisionProbeResult {
  /** The HTTP status the route answered. */
  status: number;
  /** The `code` on a refusal body, when it refused. */
  code?: string;
  /** Whether the approval actually left `pending`. */
  decided: boolean;
  /** Whether the approval is still pending and still decidable afterwards. */
  stillPending: boolean;
}

export type ApprovalDecisionProbe = () => Promise<ApprovalDecisionProbeResult>;
```

Expected outcome per credential, asserted by `checkApprovalAuthorityConformance(probes)`:

| Credential                              | `decided` | `status` | `code`                | `stillPending` |
| --------------------------------------- | --------- | -------- | --------------------- | -------------- |
| `session-cookie`                        | `true`    | 200      | -                     | `false`        |
| `person-api-key`                        | `true`    | 200      | -                     | `false`        |
| `agent-api-key`                         | `false`   | 403      | `AGENT_CANNOT_DECIDE` | `true`         |
| `agent-api-key-without-identity-header` | `false`   | 403      | `AGENT_CANNOT_DECIDE` | `true`         |
| `no-credential`                         | `false`   | 401      | `AUTH_REQUIRED`       | `true`         |

Every probe drives the real Express stack with `auth.enabled: true` and `sessionGate` then `resolveAgentIdentity` mounted in the shipped order (`app.ts:143`, `:151`), and creates its approval through `enforceCapabilityTier` rather than by writing a row, so the probe exercises the path that ships.

`agent-api-key-without-identity-header` is the reported defect, verbatim. It is listed separately from `agent-api-key` because they fail for different reasons: the first can only be caught by the credential check, and if someone deletes that check while leaving the header check, exactly one row in this table goes red.

**Test the test.** Two seeded regressions, each asserted to fail the checker: flip `classifyApiKeyScope` to always return `person`, and exactly the two agent rows must fail; delete the scope branch of `agentSelfApprovalRefusal`, and the same two rows must fail. Plus a table-driven unit test of `classifyApiKeyScope` over `null`, the agent shape, and an unrecognized non-null value.

**What this proves.** On an instance with login on, the approval decide routes refuse a request whose only credential is a key DorkOS minted for an agent, whether or not that request also presents an identity header, and a refusal leaves the approval pending and decidable.

**What this does not prove.** Stated here so nobody cites it for more:

- Nothing about the `local-trust` posture. With login off there is no credential to classify and every probe would be vacuous. This is not a proof that agents cannot approve their own actions in DorkOS; it is a proof about instances with login on.
- Nothing about how an agent came to hold a credential. An agent that reads the operator's own key off disk presents a person-scoped key and passes. The probe pins what DorkOS's own credential can do, not what an agent can obtain.
- Nothing about surfaces not in the list. It covers the two decide routes. A future approvals MCP tool, capability, or bulk endpoint is unproven until someone adds it here, exactly like the hand-maintained choke-point list ADR 260725-133220 already records as a negative consequence.
- Nothing about keys written outside DorkOS's minting path. A row inserted directly gets `permissions: null` and classifies as a person's key, deliberately (§3.6).

### 3.9 The posture lock

`operator.config_patch` is tier `act`, so it needs no approval (`operator-capabilities.ts:222-228`), and `applyConfigPatch` deep-merges anything that validates against `UserConfigSchema` with no write allowlist (`config-patch.ts:123-160`). `auth.enabled` is an ordinary schema field. So a caller on the capability surface can set `auth.enabled: false`, drop the instance into `local-trust`, and make every credential check in this spec unreachable.

`createConfigPatchHandler` refuses any patch whose flattened keys (`flattenConfigKeys`, `config-patch.ts:87-101`) intersect a named `POSTURE_CONFIG_KEYS` set, currently `['auth.enabled']`. The refusal is a `CapabilityToolError` naming the key and saying that login is changed by a person in Settings > Security or with `dorkos auth`, never by a tool.

The guard sits at the capability handler, **not** inside `applyConfigPatch`, because the cockpit's own enable and disable flow goes through the same function (`OwnerSetupHost.tsx:29`, `SecurityPanel.tsx:43`, `:48` via `PATCH /api/config`) and must keep working.

This is the one part of the spec that applies in both postures, because it is not a credential check. It is the reason the rest of the spec is worth writing.

### 3.10 The card says who asked

`requesterLabel` currently returns `undefined` for a caller with no identity, and the card reads "An unidentified caller" (`tier-enforcement.ts:305`, `:320-324`). With an agent-scoped credential present, DorkOS knows more than that even without the header: it knows a non-person asked.

When the request carries an agent-scoped credential and no resolved identity, the card says so ("An agent asked, but it did not say which one") rather than "An unidentified caller". This is small, and it is the surface where the defect would have been visible to a person: an approval card that says an agent asked, arriving at the same moment nobody clicked anything, is the tell.

Threading the credential scope into `enforceCapabilityTier` follows the existing `TierEnforcementRequest` options-object shape (the delta already recorded in `specs/agent-trust/04-implementation.md:15`). The gate's decision does not change: tier still decides, per ADR 260725-133220. Only the summary text does.

## User Experience

For the operator, almost nothing changes and one thing gets better. Agents that DorkOS runs keep working when login is on, and keep working past the tenth command. The operator no longer needs to copy their own key anywhere for agents to work. Settings > Security shows which keys belong to agents. Approval cards say an agent asked when an agent asked.

The one visible change: if an operator had been driving approvals from a script using a key they placed for an agent, and that key is now agent-scoped, the script gets a 403 with a message saying approvals are decided by a person. That is the intended behavior, and it only affects keys DorkOS minted, never one the operator created.

## Testing Strategy

**Unit.** `classifyApiKeyScope` over `null`, the agent shape, and an unrecognized non-null value. `verifyRequestAuth` returning `credential: 'session'` for a cookie and `'api-key'` with the right scope for each key kind, including a key whose verify comes back `valid: false` with `RATE_LIMITED` (returns `null`, 401). The minting helper: no `DORKOS_API_KEY` when login is off, correct server-only fields when it is on, plaintext never logged, spawn proceeds on minting failure.

**Integration.** The five decide-route cases from §3.8, driven through the real app. `POST /api/approvals/:id/grant` with an agent-scoped key leaves the approval listed by `GET /api/approvals/pending`. The full defect walked end to end: destructive invoke returns 202, the same credential is refused at grant, a cookie grants it, the retry with the token succeeds.

**Conformance.** `checkApprovalAuthorityConformance` wired into the existing `capabilityConformance` describe block, with both seeded regressions asserted to fail it.

**Posture lock.** `config_patch` with `{ auth: { enabled: false } }` is refused and `auth.enabled` is unchanged; `PATCH /api/config` with the same body still succeeds (the cockpit path).

**Rate limit.** A regression test that an agent-minted key survives more than ten consecutive verifications, and (as task 1) a reproduction that a cockpit-created key does not.

**Redaction.** Extend the existing fixture that covers `DORKOS_AGENT_TOKEN` to cover `DORKOS_API_KEY`.

## Performance Considerations

`verifyRequestAuth` gains two field assignments and one Zod parse of an already-fetched JSON object. No new query, no new round trip; `permissions` comes back on the verify result that is already being made. Minting is one insert per agent spawn, and only when login is on. The expired-key sweep piggybacks the existing maintenance cadence. Turning off the plugin's rate limiting for agent keys removes a per-request DB write path for those keys (`index.mjs:1718-1733` writes `requestCount` / `lastRequest` on every verify in database storage mode), so agent traffic gets slightly cheaper, not more expensive.

## Security Considerations

The residual limit is stated in §3.7 and is the most important sentence in this document: on a machine where agents run as the operator's OS user, credential scoping makes self-approval unnecessary and visible, not impossible. Anything claiming more than that is wrong.

Beyond that: key material is returned once by the plugin and goes straight into a child process environment, never to disk and never to a log. An agent-scoped key cannot mint a better one, verified twice over in the installed plugin (`enableSessionForAPIKeys` defaults to `false` at `index.mjs:2285`, and `createApiKey` requires a cookie session for any client request at `:733`, `:749-754`; the plugin never reads `Authorization: Bearer` at all). The scope field is server-only-writable at create and at update, so a cookie session cannot promote an agent key or demote its own. `MCP_API_KEY` and the local MCP token are not accepted by `sessionGate` and therefore cannot reach the decide routes. The posture lock (§3.9) closes the escalation that would otherwise make all of this moot.

Fail-closed choices: an unrecognized non-null `permissions` value classifies as `agent`; a refused decision never touches the approval; a failed mint degrades to today's behavior rather than to an unscoped credential.

## Documentation

- `docs/guides/cli-usage.mdx:246-266` - rewrite the "If your DorkOS asks you to sign in" section. It currently recommends the key file **because** agents inherit it (`:264`). That sentence goes. New framing: the key file is for your own shell; agents DorkOS runs get their own key and need nothing from you.
- `docs/self-hosting/securing-your-instance.mdx:77-116` - explain the two kinds of key and which one can approve.
- `docs/self-hosting/threat-model.mdx` - state the §3.7 residual limit plainly, in the same place it already describes the local trust model (`:63`).
- `contributing/authentication.md` - the authority table from §3.1, the scope field, and the minting seam.
- `contributing/agent-operator-surface.md` - the posture lock, and the rule that `auth.*` is not tool-writable.
- Changelog fragment per PR, at the `writing-for-humans` bar.

No entry in `contributing/configuration.md`, because no config field is added (see Open Questions).

## Implementation Phases

Two phases. **The invariant is not true until phase 2 lands, and must not be claimed before then** (the demo-claim gate applies to security properties too).

**Phase 1 - make an agent's credential its own.**

1. Reproduce the ten-per-day rate limit against a running server with login on. Record the result either way; the rest of the phase does not depend on the outcome.
2. Posture lock (§3.9). Independently valuable, applies in both postures, ships first.
3. `classifyApiKeyScope` and the shared Zod shape (§3.2).
4. Server-side minting at the spawn seam, with `permissions`, `rateLimitEnabled: false`, `userId`, `expiresIn` (§3.4), plus revocation and sweep.
5. Redaction fixture extension.

**Phase 2 - make the distinction mean something.**

6. `credential` and `scope` on `RequestUser` (§3.2).
7. The decide-route refusal (§3.3).
8. `ApprovalDecisionProbe`, `DECIDING_CREDENTIALS`, `checkApprovalAuthorityConformance`, and both seeded regressions (§3.8).
9. Security-panel scope labels (§3.6) and the approval-card wording (§3.10).
10. Docs and changelog.

Decomposition in `03-tasks.json`.

## Open Questions

- ~~Should the scope live in `metadata` or `permissions`?~~ **(RESOLVED)** `permissions`. It is the only per-key field the installed plugin refuses to let a cookie-session client write, at create (`index.mjs:734-736`) and at update (`index.mjs:1481-1487`). `metadata` is client-writable whenever `enableMetadata` is on and is silently dropped when it is off, so it cannot carry authority.
- ~~Should DorkOS pass `permissions` to `verifyApiKey` and let the plugin authorize?~~ **(RESOLVED)** No. That path rejects any key with null stored permissions as `KEY_NOT_FOUND` (`index.mjs:1664-1668`), which is every key that exists today. DorkOS reads the value back and classifies it itself, so the rule is ours and is testable.
- ~~What is an unscoped legacy key?~~ **(RESOLVED)** Person-scoped. Reasoning and the operator's recommended follow-up in §3.6. The alternative breaks a person's own CLI approval flow with an error blaming an agent, which is a security change nobody keeps.
- ~~Does this need a config field, and therefore a semver-keyed migration?~~ **(RESOLVED)** No, on both counts. The scope lives on the `apikey.permissions` column, which already exists in the schema (`packages/db/src/schema/auth.ts:130`) and in applied migration `0022` (`:40`), so there is no database migration either. The posture is the existing `auth.enabled`. A knob such as "require a cookie to approve" would be a dial whose only settings are the safe default and something less safe, so it is not offered. If a later round does add a field, it follows `contributing/configuration.md` and the `adding-config-fields` skill: append-only migration keyed to the release version, guarded by `store.has()`.
- ~~Should deciding require a session cookie, refusing every API key?~~ **(RESOLVED)** No. Strictly stronger, but it forecloses a headless operator and a future `dorkos approve` verb while buying nothing today (no CLI decide verb exists). Revisit if one is added, since a person-scoped key on disk is the weakest link that remains.
- ~~Should the two credentials be collapsed into one?~~ **(RESOLVED)** No. Reasoning in §3.5. Revisit if login-on ever becomes the default posture.
- **(OPEN)** Does the Better Auth **client** SDK's `listApiKeys` response type surface `permissions`? The endpoint parses and returns it (`index.mjs:1323`), but the client type was not verified. If it does not, the Security panel needs a small server-side projection instead. Resolve during phase 2, task 9.

## Related ADRs

260725-133220 (the action's tier decides the gate; identity only caps it - this spec extends the same reasoning to the decide side, where a caller-chosen header is still the only check), 260725-133221 (an approval binds to the exact action the person saw - unchanged; this spec constrains who may make the decision, not what the decision covers), ADR-0315 (raw secrets never live in `config.json`, which is why the CLI key sits in its own file), 260725-152018 (the agent-facing config snapshot is an allowlist - §3.9 is the write-side counterpart).

Candidate ADRs to extract on completion: "an API key carries a scope, and an agent's key cannot decide"; "the trust posture is not tool-writable".

## References

- `apps/server/src/services/core/auth/session-gate.ts` (the gate, `verifyRequestAuth`, `RequestUser`)
- `apps/server/src/routes/approvals.ts` (the decide routes and today's refusal)
- `apps/server/src/services/core/agent-identity/agent-token-env.ts` (the spawn seam)
- `apps/server/src/services/core/capabilities/tier-enforcement.ts` (the request side of the gate)
- `apps/server/src/services/core/operator/config-patch.ts` (the unguarded write path)
- `packages/cli/src/lib/api-client.ts` (the CLI credential path)
- `packages/test-utils/src/capability-conformance.ts` (the pattern the new probe follows)
- `node_modules/@better-auth/api-key@1.6.23/dist/index.mjs` (every plugin claim above)
- `specs/agent-trust/02-specification.md` §3.1-3.3 and `04-implementation.md`
