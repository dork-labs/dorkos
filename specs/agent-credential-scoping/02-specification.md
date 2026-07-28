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
**Re-verified:** 2026-07-27 against `origin/main`
**Tracker:** DOR-474 (P1), project "Agents as First-Class Operators"

## Overview

Give an API key a scope, so DorkOS can tell a credential it issued to an agent from a credential a person carries, and refuse the agent-scoped one at the approval decide routes. DorkOS mints the agent-scoped key itself at the same seam that already mints the agent identity token, which also fixes a shipped defect: a cockpit-created key is capped at ten verifications a day, so the CLI credential path an agent depends on stops working almost immediately when login is on. The scope lives in Better Auth's `permissions` column, which is the only per-key field the plugin refuses to let a browser client write.

Scoped entirely to the `signed-in-operator` posture (`auth.enabled: true`). Section 3.7 says why, and says what is still not true afterwards.

**Sequencing, decided 2026-07-27.** The hole itself is closed first by a cookie bar on the decide route, which costs nothing because every first-party client already sends a cookie. Scoping then follows as phase 2 and buys what a cookie bar cannot: a headless operator that can still decide, an agent that never needs the operator's key, and a card that can say an agent asked. Reasoning and caveats in Open Questions; phase order in Implementation Phases.

## What changed between writing this and 2026-07-27

This branch was cut on 2026-07-25 and six PRs have landed on ground it stands on. The defect is unchanged and still composes; the surroundings moved. Corrections are folded into each section below, and the summary is here so a reader does not have to find them:

| Section  | What it said                                                | What is true now                                                                                                                                                                                                                     |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3.3     | Edit `agentSelfApprovalRefusal` in `routes/approvals.ts`    | That function is gone. The decide check is `resolveDecisionAuthority` (#465), and it already refuses an agent header and an approval token in both postures. The new check goes there                                                |
| §3.2     | Add `credential` and `scope` to `RequestUser`               | `credential: 'cookie' \| 'api-key'` already shipped (#486, DOR-505). Only `scope` is new, and the union member is `'cookie'`, not `'session'`                                                                                        |
| §3.2     | `res.locals.user` is read nowhere                           | False. Read at `lib/caller-authority.ts:67` and `:206`, and `routes/room-caller.ts:63`                                                                                                                                               |
| §3.9     | Add a posture lock so `auth.enabled` is not tool-writable   | **Shipped.** `config-write-policy.ts` (#469) classifies every config leaf with a drift guard, `PATCH /api/config` got the same guard (#476), and DOR-505 added the cookie bar. §3.9 is now a record, not a task                      |
| §3.4     | `expiresIn: TOKEN_IDLE_TTL_MS`                              | Wrong unit AND wrong clock. `expiresIn` is in SECONDS, caps at 365 days, and is ABSOLUTE: never refreshed by use. The identity token's 7-day window is sliding. Use `TOKEN_ABSOLUTE_TTL_MS / 1000`                                   |
| §3.4     | Mint at the `resolveAgentTokenEnv` seam                     | That seam has two call sites, claude-code and codex. **OpenCode has none**, and OpenCode is in this spec's own premise                                                                                                               |
| §3.8     | Add `ApprovalDecisionProbe` / `ApprovalDecisionProbeResult` | Both names are taken, by #476, for a different probe (requester-cannot-decide). `GATED_ADAPTER_PATHS` and `checkDestructiveGateConformance` no longer exist; the pattern to follow is `checkRegistryGateConformance`                 |
| Standing | Not discussed                                               | Standing permissions shipped (DOR-501) and creating one already requires a session cookie (`routes/approvals.ts:382`). An agent-held key cannot open one. It can still decide a **one-time** approval, which is the remaining defect |

## Background / Problem Statement

The approval primitive (spec `agent-trust` §3.3) exists so a person stands between an agent and an irreversible action. ADR 260725-133220 established that the action's tier decides the gate and identity only narrows it, so an agent cannot slip past by dropping its identity header on the way in. On the way out, the same trick still works.

An agent calls a destructive capability, receives `approvalId` and `approvalToken` in the 202 (`tier-enforcement.ts:821-833`, `routes/capabilities-invoke.ts:96-108`), then calls `POST /api/approvals/:id/grant` with `Authorization: Bearer <key>`, no `X-DorkOS-Agent` header, and no `X-DorkOS-Approval` header. `sessionGate` resolves a user from the key and records `{ userId, credential: 'api-key' }` (`session-gate.ts:128-132`, `:187`). `resolveDecisionAuthority` then clears all three of its refusals: no agent header (`decision-authority.ts:152`), no approval token (`:163`), and login is on with a user present (`:180`), so it returns `signed-in-operator` (`:189`). The approval is granted by the thing that asked for it.

The two header checks cannot help, because both read headers the caller chose to send or omit (`lib/caller-authority.ts:66-75`). The credential check cannot help either, because it asks whether a credential is present and never what kind it is. That is the whole of the defect, and it is the residual `decision-authority.ts` already names in its own module doc, citing DOR-474.

The key is in the agent's hands legitimately. `packages/cli/src/lib/api-client.ts:169` reads it from `DORKOS_API_KEY` or `<dork home>/api-key` and attaches it to every call (`:186`, merged at `:248`), which is required: without it Codex and OpenCode agents cannot reach the operator surface at all when login is on. `docs/guides/cli-usage.mdx:273` recommends the key file specifically because agents inherit it. Nothing on the machine mints that file; the operator writes their own key into it by hand.

So the credential is the same object for two authorities: "may this request reach the API" and "is a person present". This spec separates them.

## Goals

- With login on, a credential DorkOS minted for an agent is refused at `POST /api/approvals/:id/grant|deny`, whether or not it also presents an identity header, and the approval is left pending.
- The same credential stops being a `trustedCaller`, so it cannot take the act-without-an-approval shortcut either. Deciding and acting-without-deciding stay the same question, which is what `trusted-caller.ts` is built on.
- An agent DorkOS spawns receives its own API key, so the operator never has a reason to put their personal key where an agent can read it.
- An agent's key works for the whole operator surface at real usage volumes, not for ten calls a day.
- Every runtime DorkOS spawns agents for gets the same treatment, OpenCode included.
- The invariant is falsifiable: a named conformance probe fails if a later change re-opens the path, and the probe's doc says exactly what it proves and what it does not.
- Nothing regresses for an agent that works today. The CLI fix stands.

## Non-Goals

- Fixing the `local-trust` posture. Login off is the default and a credential-free caller with shell access is indistinguishable from the cockpit. See §3.7.
- Preventing an agent from stealing a person's credential off the machine it shares with them. See §3.7.
- Per-capability permissions on a key. The tier gate already decides what may run; scope decides only who may decide.
- Retiring the `X-DorkOS-Agent` header check. It stays as the honest-caller check, alongside the new one.
- Replacing the agent identity token with the API key, or the reverse (§3.5).
- A `dorkos approve` CLI verb. None exists today, and the two phases treat it differently, so stating it flatly either way is wrong: **under phase 0 alone it could not work**, because it would hold a key and no key decides; **phase 2 is what makes it possible again**, via a person-scoped key. §3.3 leaves room for one, and phase 2 is its prerequisite.
- Any change to `MCP_API_KEY` or the local MCP token (`middleware/mcp-auth.ts:59-61`, `:86-87`). Neither is accepted by `sessionGate`, so neither can reach `/api/approvals/*`.
- The posture lock. It shipped while this branch sat; §3.9 records it rather than proposing it.

## Technical Dependencies

Internal only. `@better-auth/api-key@1.6.23` (declared `^1.6.23` at `apps/server/package.json:29`), configured as `apiKey()` with zero options at `apps/server/src/services/core/auth/index.ts:138`. The `apikey.permissions` column already exists in the Drizzle schema (`packages/db/src/schema/auth.ts:130`) and the applied migration (`packages/db/drizzle/0022_absurd_cassandra_nova.sql:40`), so no database migration is required. Also: `verifyRequestAuth` / `sessionGate` (`services/core/auth/session-gate.ts`), `resolveDecisionAuthority` (`services/core/approvals/decision-authority.ts`) and its request reader (`lib/caller-authority.ts`), the agent-identity spawn seam (`services/core/agent-identity/agent-token-env.ts:42-65`) and its runtime call sites, the approvals routes and service, and `packages/test-utils/src/capability-conformance.ts`.

## Detailed Design

### 3.1 The authority model

Three authorities exist today. Naming them is most of the design.

| Authority                      | Enforced at                                              | Credentials that may exercise it (after this spec)                                                                                |
| ------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Reach the operator surface** | `sessionGate` (`session-gate.ts:157-193`)                | session cookie, person-scoped key, agent-scoped key                                                                               |
| **Invoke a capability**        | `enforceCapabilityTier` (`tier-enforcement.ts:673`)      | any credential that reached the surface; `destructive` stops for an approval regardless of credential kind, per ADR 260725-133220 |
| **Decide an approval**         | `resolveDecisionAuthority` (`decision-authority.ts:146`) | session cookie, person-scoped key. **Never an agent-scoped key**                                                                  |

Two more authorities shipped after this table was written:

- **Act without an approval**, enforced by `trustedCaller` (`services/core/capabilities/trusted-caller.ts:134`), which delegates to the same `resolveDecisionAuthority` on purpose. Its invariant is "whoever may decide an approval may act without one", so it moves with row three by construction, in both directions. §3.3 says what that costs.
- **Open a standing permission**, enforced by `requireOperatorCookie` (`lib/caller-authority.ts:224`), which under login-on accepts a session cookie and nothing else.

So the repo already has one effect that no key of any kind may cause. **The decide route joins it**: Dorian resolved on 2026-07-27 that a cookie is required to decide, shipping ahead of scoping (Open Questions). Row three then reads "session cookie only" until phase 2 adds the scope, at which point a person-scoped key is let back in and an agent-scoped one stays out.

The invariant, stated so it is checkable rather than aspirational:

> **A credential DorkOS issues to an agent may request a destructive action and may never decide one.**

The stronger-sounding form ("a credential that can request must not approve") is false as written, because a person's own credential can do both, and that is correct: a person approving their own request is what an approval is. The scoping question is only whether the requester is a person.

Credential kind is not the same axis as ownership. Every key is owned by the same user (registration is owner-only, `auth/index.ts:153-181`), so `referenceId` can never carry this distinction. That is why it needs a field of its own.

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

`RequestUser` (`session-gate.ts:40-56`) gains **one** field. The `credential` field this section originally proposed already shipped in DOR-505, and its union member is `'cookie'`, not `'session'`:

```ts
export interface RequestUser {
  userId: string;
  /** Which credential proved this request. Already shipped (DOR-505). */
  credential: 'cookie' | 'api-key';
  /** NEW. Whether the credential belongs to a person or to an agent DorkOS spawned. */
  scope: 'person' | 'agent';
}
```

A session cookie is always `{ credential: 'cookie', scope: 'person' }`. Better Auth cookies are `httpOnly` (`auth/index.ts:144-149`), so a cookie is the closest thing DorkOS has to evidence that a person is at a keyboard.

The addition is still additive, but not because nothing reads `res.locals.user`. Three places do, and the field is required rather than optional, so all three have to keep compiling: `readCallerAuthority` (`lib/caller-authority.ts:67`) passes the whole object through untouched, `requireOperatorCookieUnderLogin` (`:206-207`) reads only `credential`, and `routes/room-caller.ts:63` reads only `userId`. None of them branches on `scope`, so adding it changes no existing behavior. The other consumer of `verifyRequestAuth` (`middleware/mcp-auth.ts:72`) only tests truthiness.

**Make `scope` required, like `credential`, and for the same stated reason.** An optional field would read as "person" by accident wherever someone forgot to set it, which is the polarity that fails open. Every site that resolves an identity says which credential it verified and who it belongs to.

### 3.3 Refusing the decision

**The function this section originally named is gone.** `agentSelfApprovalRefusal` was replaced by `resolveDecisionAuthority` (`services/core/approvals/decision-authority.ts:146`) in PR #465, which does strictly more than the original: it refuses an agent header and an approval token in **both** postures, and under login-on it requires an authenticated user. The new check goes there, as a third refusal.

`DecisionAuthorityRequest` gains nothing: the scope arrives on the `user` field it already carries. `resolveDecisionAuthority` grows one branch, placed **after** the two header refusals and **before** the posture branch, so that an agent-scoped credential is refused in the login-off posture too. That placement costs nothing (with login off there is no `user` to have a scope) and it is the ordering that stays correct if login-off ever gains credentials.

**Editing that function reaches further than the decide routes, and this spec has to own that.** `resolveDecisionAuthority` has two families of consumer:

1. The four approvals routes, through `decisionAuthority()` (`routes/approvals.ts:137`): `POST /:id/grant`, `POST /:id/deny`, `GET /grants`, `DELETE /grants/:id`.
2. `trustedCaller` (`services/core/capabilities/trusted-caller.ts:134`), which is the one way a caller reaches a capability **without** the tier gate. Six call sites: `routes/config.ts:319`, `routes/marketplace.ts:302` and `:343`, `routes/tasks.ts:158` and `:266`, and `routes/extensions-approval.ts:120`.

So an agent-scoped key stops being a trusted caller too. **That is intended, and it is the reason to put the check in the shared predicate rather than in the routes.** The invariant `trusted-caller.ts` is built on is "whoever may decide an approval may act without one", and it holds in both directions: a caller that cannot grant its own approval must not be handed the effect directly either, or the gate is two steps of theatre. Splitting the check would break that sentence, which the module doc calls the load-bearing design decision.

**Six call sites, but the change is observable at four.** Two of them sit downstream of a cookie bar that already refuses an API-key caller under login-on, so their behavior does not move:

| Site                                | Observable? | Why                                                                                                                  |
| ----------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `routes/marketplace.ts:302`         | **Yes**     | No cookie bar on the path                                                                                            |
| `routes/marketplace.ts:343`         | **Yes**     | No cookie bar on the path                                                                                            |
| `routes/tasks.ts:158`               | **Yes**     | No cookie bar on the path                                                                                            |
| `routes/tasks.ts:266`               | **Yes**     | No cookie bar on the path                                                                                            |
| `routes/config.ts:319`              | No          | Inside the `if (operatorOnly.length > 0)` block, after `requireOperatorCookieUnderLogin` at `:286` returns at `:291` |
| `routes/extensions-approval.ts:120` | No          | After the cookie bar at `:107`, which returns at `:112`                                                              |

The distinction is not pedantry. This spec tells an implementer to write a case per site, and a case on either of the last two rows would pass on the day it is written whether or not the scope check exists: the assertion would be satisfied by the cookie bar, not by the thing under test. That is REVIEW.md's "assertion satisfied by the wrong subject". Write four cases that can fail, and for the other two assert what is actually true, that the cookie bar refuses first, so a later reordering that puts `trustedCaller` in front is caught.

The practical consequence, which belongs in the PR description and in the release note: with login on, an agent holding a DorkOS-minted key that runs `dorkos uninstall` or writes a task will now see the approval card instead of the effect, even with its agent header stripped.

The three checks in order, with what each is worth:

1. The caller presents an agent identity header, resolved or not (`:152`). Unchanged. Weak by construction, since the caller chooses whether to send it, and still worth keeping: it is what stops an honest agent, and it is what makes the log honest.
2. The caller presents an approval token (`:163`). Unchanged. Holding the retry secret is what makes a caller the requester.
3. **New.** `request.user?.scope === 'agent'`. The load-bearing check, because the server issued that credential and the caller cannot choose not to present it and still get through `sessionGate`.

All three return before the route touches `ApprovalService`, so a refused decision never consumes, expires, or otherwise disturbs the approval. It stays pending for the person it was always waiting on.

**They must not all answer the same code, and this is a correctness requirement rather than a wording preference.** An earlier draft of this section had all three answer `403 AGENT_CANNOT_DECIDE`, on the reasoning that from the caller's side the three reasons mean the same thing. That is true for the caller and false for the test suite, which is the problem:

- **A shared code makes the probe unable to fail.** If the credential refusal and the header refusal are indistinguishable in the response, then deleting the credential check changes nothing observable for a caller that also sends an identity header: the header check answers first, with the same status and the same code, and the conformance row stays green. A security probe whose row cannot go red when the thing under test is removed is `.claude/rules/testing.md`'s "assertions that cannot fail", and REVIEW.md's "assertion satisfied by the wrong subject". §3.8's table is exactly that probe, so the codes have to differ for it to prove anything.
- **A shared message is also wrong for the person reading it.** Under the phase 0 cookie bar, a refused caller may be the operator's own script holding the operator's own key. Telling that person "not by an agent" names the wrong cause and gives them nothing to act on.

So the credential refusal takes its own code and its own sentence, saying that approvals are answered in the DorkOS cockpit and inviting the person to open it, at the `writing-for-humans` bar. The exact code is the implementing PR's to choose and to pin in §3.8's table.

**One code per check is already the shipped pattern, not a new rule.** The two existing refusals do not share a code either: the identity-header check answers `AGENT_CANNOT_DECIDE` (`decision-authority.ts:156`) and the approval-token check answers `REQUESTER_CANNOT_DECIDE` (`:167`). An earlier draft of this section said "all three answer `403 AGENT_CANNOT_DECIDE`", which was wrong about the code that ships as well as wrong about what the third check needs. The credential refusal is the third distinct code, not an exception to a convention.

**Ordering is a requirement, and it is what makes the codes worth having.**

> **The identity-header check answers first, then the approval-token check, then the credential check, and each answers a distinct code.**

This is falsifiability, not message quality, and it is the same argument §3.8 makes about the probe table. Codes only tell you which check refused if the checks run in a known order. If the credential check ran first, every API-key caller would get the credential code whether or not it sent an identity header, the two refusals would become indistinguishable again, and deleting the header check would be unobservable to the probe. Distinct codes plus a fixed order are jointly what make each check independently deletable and detectable. Either one alone proves nothing.

**This pins existing behavior rather than requiring a change,** which is what makes it cheap. `resolveDecisionAuthority` already runs the header check first (`decision-authority.ts:152-159`), then the approval-token check (`:163-170`), then the posture branch. The requirement exists so that a future reordering reads as the regression it would be, and so the phase 0 table in §3.8 is grounded in something the spec actually guarantees. The PR implementing the cookie bar places its refusal so the header check still answers first; keep the two aligned rather than letting them drift.

Standing permissions need no change. Creating one already requires a session cookie (`requireOperatorCookie`, reached at `routes/approvals.ts:382`), which no key of any scope can present, so an agent-held key could never open one. This spec closes the one-time decide path that bar does not cover.

If an approvals capability or MCP tool is ever added, it inherits this check and must be added to the named list in §3.8. There is no such surface today: `packages/cli/src` contains no approvals command, and no capability projects onto the approval routes.

### 3.4 Minting an agent's key

Today nothing mints `<dork home>/api-key`. DorkOS starts doing so, at the seam that already hands an agent its identity.

`resolveAgentTokenEnv(agentPath, displayName)` (`agent-token-env.ts:42-65`) currently returns `{ DORKOS_AGENT_TOKEN }`. It gains a sibling that, **only when `configManager.get('auth')?.enabled === true`**, also returns `DORKOS_API_KEY`. With login off nothing is minted, because nothing is needed.

**The seam does not reach every runtime.** On 2026-07-27 `resolveAgentTokenEnv` has two production call sites: `runtimes/claude-code/messaging/message-sender.ts:399` and `runtimes/codex/codex-runtime.ts:484`. Nothing under `runtimes/opencode/` calls it, so an OpenCode agent gets no identity token today and would get no key either. OpenCode is named in this spec's own premise as one of the runtimes that needs the CLI credential path, so leaving it out would mean the one runtime the spec argues from is the one still falling back to the operator's person-scoped key.

**On sequencing, corrected.** An earlier draft said this "has to be fixed first" and was "a task of its own, ahead of the minting work". That ordering was written when minting was phase 1 and the decide refusal depended on it. It no longer holds: phase 0 closes DOR-474 with a cookie bar and needs none of this. The gap is real and it is independent, so it wants its own ticket rather than a slot in a sequence, and it does not block phase 0 or phase 2's decide work.

The reasoning for handling it separately is unchanged and is about attribution, not credentials: an OpenCode agent that starts carrying `DORKOS_AGENT_TOKEN` starts being refused by the agent-identity checks it currently slips past, which is correct and is a behavior change reviewers should see on its own. If it turns out that OpenCode's spawn has no env seam to hang this on, the spec's premise narrows to claude-code and codex and says so, rather than the gap going unmentioned.

The key is created by a headless server-side call: `auth.api.createApiKey({ body: { ... } })` with **no `headers` argument**. That is what makes the server-only fields writable (`index.mjs:734-736` rejects them for any call carrying `ctx.request` or `ctx.headers`), and it is the only way to set any of the four fields that matter:

| Field              | Value                                             | Why                                                                                             |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `permissions`      | `{ dorkos: ['agent'], agentPath: [<agentPath>] }` | The scope (§3.2). Server-only, which is the whole point                                         |
| `rateLimitEnabled` | `false`                                           | The plugin default is 10 requests per rolling day and it is enforced on every verify. See below |
| `userId`           | the owner's id                                    | Allowed only on a headless call (`index.mjs:736`); there is no session to infer it from         |
| `expiresIn`        | `TOKEN_ABSOLUTE_TTL_MS / 1000` (2,592,000 s)      | The identity token's hard ceiling. The two clocks are not the same; see below                   |

Also `name: "Agent: <displayName or agentPath>"`, so the key is legible in Settings > Security.

**On `expiresIn`, because getting this wrong ships a silent no-op, twice over.**

_The unit._ The plugin reads `expiresIn` in seconds: it computes `expiresIn / (3600 * 24)` and rejects the result against `maxExpiresIn`, which defaults to 365 days (`index.mjs:785-791`, defaults at `:2278-2279`). This spec originally said `TOKEN_IDLE_TTL_MS`, which is 604,800,000, reads as 7,000 days, and throws `EXPIRES_IN_IS_TOO_LARGE`. Combined with "failure is not fatal, logged at warn" below, every mint would have failed quietly.

_The clock, which is the subtler error._ The two credentials do **not** age out together, and the earlier draft of this section claimed they did. The identity token runs two clocks: a **sliding** 7-day idle window (`TOKEN_IDLE_TTL_MS`, `agent-identity-service.ts:69`, checked at `:160` against `lastActivity`) under a **hard** 30-day ceiling (`TOKEN_ABSOLUTE_TTL_MS`, `:75`, checked at `:156` against `createdAt`). Better Auth has no sliding clock at all: `expiresAt` is written once at create (`index.mjs:821`) and compared to `Date.now()` on every verify (`:1636-1637`), never refreshed by use, and an expired key is **deleted** before the 401 comes back.

So a 7-day `expiresIn` would hard-expire the key of an agent that is working continuously, exactly the agent that keeps renewing its identity token. It would start 401ing mid-run, with no re-mint path in this spec and "failure is not fatal" hiding the cause. Use `TOKEN_ABSOLUTE_TTL_MS / 1000` (2,592,000 s, well under the 365-day cap), so the key outlives every identity token that could be minted beside it and the ceiling is the thing both credentials share.

Name the unit at the call site, and pin the value with a test that drives a real `createApiKey`, not a mock. Neither of these two errors is visible to a mock.

**On the rate limit.** `apiKey()` with no options resolves `rateLimit: { enabled: true, timeWindow: 86400000, maxRequests: 10 }` (`index.mjs:2270-2274`), writes those as concrete columns on every created key (`index.mjs:826-831`), and enforces them on every `verifyApiKey` (`index.mjs:1609-1613`, `:1790-1794`), which `verifyRequestAuth` sees as `valid: false` and turns into a 401. The CLI presents its key on every call and holds no cookie, so every call burns one. This is a shipped defect independent of scoping: an agent using the CLI with login on gets about ten requests and then starts failing. Traced in the installed plugin source, **not reproduced against a running server** - reproducing it is the first step of Follow-up 1, which is its own ticket rather than a task in these phases, and if it does not reproduce, `rateLimitEnabled: false` is still correct for an agent key and nothing else in this spec changes.

The plugin returns the key material exactly once. It goes straight into the spawned child's environment and is never written to disk and never logged. It joins `DORKOS_AGENT_TOKEN` in the redaction fixtures (the invariant ADR 260725-152018 carries forward from 260723-013236).

**Lifecycle.** One key per spawn, matching the identity token's per-spawn lifecycle exactly rather than inventing a second one. Reuse across spawns would require persisting the plaintext, which is worse than an extra row. Rows are bounded by `expiresIn` and cleaned two ways: `AgentIdentityService.revoke(agentPath)` (`agent-identity-service.ts:320`) also revokes that agent's keys, and a sweep of expired agent-scoped keys rides the same maintenance cadence approvals already use.

**Failure is not fatal, and that is exactly why it needs a test that can go red.** If minting fails, the spawn proceeds without `DORKOS_API_KEY`, logged at warn. The agent then behaves as it does today: it either finds a key the operator placed, or it gets the existing actionable 401 message. Minting must never stop an agent from starting.

The cost of that choice is that a broken mint is indistinguishable from a working one at every surface a person looks at. So the degradation is paired with a test that drives a real `createApiKey` against a real Better Auth instance and asserts a key comes back with `permissions` set and `rateLimitEnabled` false. A mocked mint cannot fail the way the `expiresIn` unit bug would have.

### 3.5 Why two credentials, and not one

An agent spawned by DorkOS with login on now carries two secrets. That is a real cost and it needs a reason.

They answer different questions, and they disagree on what absence means. The API key answers "may this request reach the API": absent, with login on, the answer is 401. The identity token answers "who is asking and what is their ceiling": absent, the answer is "unattributed", and the request proceeds. That asymmetry is deliberate and load-bearing. ADR 260725-133220 turns on it: the tier gate keys on the action's tier and never on whether the caller identified itself, precisely so that dropping the identity token cannot widen what a caller may do.

Collapsing them means making the identity token authorizing. In the login-on posture that would be a small gain (dropping it 401s). In the login-off posture, which is the default, it is a loss: dropping it still reaches everything, and now also sheds the `tierCeiling`. The credentials also disagree on verifier (Better Auth versus `AgentIdentityService`), on revocation granularity (per key versus agentPath-wide), and on applicability (the identity token matters in both postures, the key only in one).

They are not collapsed. They are co-located: minted together at one seam, bounded by the same 30-day ceiling, revoked together. Not _expiring_ together, which an earlier draft claimed: the identity token can die at 7 idle days while the key lives to 30 (§3.4). Co-location is about the seam and the operator's mental model, not about the clocks.

This decision would be worth revisiting if login-on ever became the default posture, at which point the identity token's login-off role disappears and the argument changes.

### 3.6 Migration: an unscoped key is a person's key

Every key on every existing install has `permissions: null`, including the row `seedLegacyMcpApiKey` inserts directly through Drizzle (`seed-legacy-mcp-key.ts:73-87`). Those all classify as `person`.

The alternative was considered and rejected. Treating an unscoped legacy key as agent-scoped would close the hole for existing keys, at the cost of silently taking the deciding authority away from a credential an operator already relies on: a person whose CLI holds a key, on an instance with login on, would find approvals refusing them with an error that blames an agent. A security change a person cannot debug is not one they will keep.

Person-scoped is chosen because the hole it leaves is narrower than it looks. The hole is not "an agent can decide"; it is "an agent that has been handed the operator's own key can decide". §3.4 removes the reason to hand it over, and the docs change (§Documentation) removes the instruction to. Reclassifying keys the operator made for themselves is the wrong tool for a problem caused by what we told them to do with those keys.

**What the operator must do.** Nothing, for correctness. Everything below is recommended and surfaced in the release note:

1. After upgrading, agents DorkOS spawns get their own key automatically. Stop putting a personal key in `~/.dork/api-key` for their benefit.
2. If you created a key only so agents could use it, revoke it in Settings > Security. The list now labels which keys are agent-scoped, so the ones that are not are the ones only you should hold.
3. Keep using `DORKOS_API_KEY` or `~/.dork/api-key` for your own shell. That is still the supported path for a person at a terminal.

The Security panel (`apps/client/src/layers/features/auth/ui/ApiKeysSection.tsx`) gains a scope label on each key. Agent-scoped keys are shown, not hidden, with the agent they belong to, and can be revoked. They cannot be created there: `permissions` is server-only, so the browser form physically cannot mint one, which is the correct affordance rather than a rule we have to enforce. (`listApiKeys` parses and returns `permissions` at `index.mjs:1323`; confirm the client SDK's response type surfaces it before relying on it, and add a small server projection if it does not.)

### 3.7 Scope, and what is still not true

**This spec applies only when `auth.enabled` is `true`.** With login off, `sessionGate` is a zero-overhead pass-through (`session-gate.ts:158-162`), no `res.locals.user` is ever set, and there is no credential to classify. A caller with shell access and no credential is indistinguishable from the cockpit, and there is no check that could tell them apart. A prior round considered and deliberately rejected an `Origin` / `Sec-Fetch` check for exactly this reason: those headers are set by browsers as a convenience, not withheld from anything else, and a check a caller can satisfy by typing it is not a security control. Nothing here revisits that.

Only §3.9 (the posture lock) applies in both postures, and it applies there because it is not a credential check at all.

**Even with login on, this does not stop a determined agent that shares an OS user with the operator.** Such an agent can read `~/.dork/api-key` off disk and `DORKOS_API_KEY` out of the environment of any process it can inspect. Scoping does not make that impossible. What it does:

- The default path stops handing agents a deciding credential, so the common case is correct rather than correct-if-configured-carefully.
- Self-approval stops being the intended flow and becomes an act of deliberate credential theft. **After phase 0 that is all this bullet may claim.** The audit trail an earlier draft promised here, an approval card naming an agent as the requester, comes from §3.10 and §3.10 is phase 2 work. Until it lands, a stolen credential produces the same "A signed-in account granted an approval" line it produces today, and nothing on the card says an agent asked.
- **Phase 0 is stronger than phase 2 on exactly one axis, and it is worth saying so.** While the cookie bar stands alone, a key read off disk cannot decide either, because no key can. Phase 2 re-admits the operator's own key and with it the theft path. That is a deliberate trade for a headless operator and a `dorkos approve` verb, not an oversight, and whoever ships phase 2 should know they are reopening this specific door.
- The invariant becomes stated and testable, so a later change that re-opens the path fails a named check instead of passing silently.

Making it actually impossible requires OS-level isolation, which is what the Docker eval tier does (ADR 260725-133222) and what a sandboxed-agent story would have to do. That is not this spec, and no part of this spec should be described as delivering it.

### 3.8 Falsifiability

**The landscape here changed, and two of the names this section proposed are now taken.** PR #476 deleted `GATED_ADAPTER_PATHS` and `checkDestructiveGateConformance`, replacing the hand-maintained adapter list with `checkRegistryGateConformance` (`capability-conformance.ts:519`), which derives its coverage from the registry so a new destructive capability cannot be added without being gated. That is the pattern to follow.

The same PR also added `ApprovalDecisionProbe`, `ApprovalDecisionProbeResult`, and `checkDecisionAuthorityConformance` (`:95`, `:132`, `:578`), for a **different** invariant: a caller presenting the approval's own retry token cannot decide it. Its module doc explicitly says it does not encode the identified-agent refusal, and it says nothing about credential kind. So the decide half is partly proven and the credential half is not proven at all.

The new check therefore takes fresh names rather than shadowing those. It joins the same file, because the halves are one gate and someone adding a surface should hit them in the same place:

```ts
/**
 * Every credential a caller can present to the approval decide routes, and
 * therefore every credential whose decide outcome must be pinned.
 *
 * Named rather than counted, for the same reason `checkRegistryGateConformance`
 * derives its coverage: adding a credential kind without pinning what it may
 * decide should be impossible to do quietly.
 */
export const DECIDING_CREDENTIALS = [
  'session-cookie',
  'person-api-key',
  'agent-api-key',
  'agent-api-key-without-identity-header',
  'no-credential',
] as const;

/** What the decide route did when handed one credential, with login on. */
export interface CredentialScopeProbeResult {
  /** The HTTP status the route answered. */
  status: number;
  /** The `code` on a refusal body, when it refused. */
  code?: string;
  /** Whether the approval actually left `pending`. */
  decided: boolean;
  /** Whether the approval is still pending and still decidable afterwards. */
  stillPending: boolean;
}

export type CredentialScopeProbe = () => Promise<CredentialScopeProbeResult>;
```

**The table has two states, because this spec now ships in two phases, and an earlier draft gave only one.** Phase 0 puts a cookie bar on the decide route, so during phase 0 a person's key is refused along with everything else. Phase 2 adds the scope and lets a person's key back in. A single table cannot describe both, and the version that described only the phase 2 end state was wrong for the code that ships first: anyone implementing the probe from it would have asserted `person-api-key` succeeds against a build where it correctly fails.

**Phase 0** (the cookie bar, closing DOR-474), asserted by `checkCredentialScopeConformance(probes)`:

| Credential                              | `decided` | `status` | `code`                | `stillPending` |
| --------------------------------------- | --------- | -------- | --------------------- | -------------- |
| `session-cookie`                        | `true`    | 200      | -                     | `false`        |
| `person-api-key`                        | `false`   | 403      | the credential code   | `true`         |
| `agent-api-key`                         | `false`   | 403      | `AGENT_CANNOT_DECIDE` | `true`         |
| `agent-api-key-without-identity-header` | `false`   | 403      | the credential code   | `true`         |
| `no-credential`                         | `false`   | 401      | `AUTH_REQUIRED`       | `true`         |

**Phase 2** (the scope re-admits a person's key). Exactly one row moves, and the phase 2 PR moves it deliberately:

| Credential       | `decided`        | `status`  | `code`          | `stillPending`   |
| ---------------- | ---------------- | --------- | --------------- | ---------------- |
| `person-api-key` | `false` → `true` | 403 → 200 | the code → none | `true` → `false` |

Every other row is identical in both phases. A phase 2 change that moves any other row is a regression, and the table is the thing that says so.

Every probe drives the real Express stack with `auth.enabled: true` and `sessionGate` then `resolveAgentIdentity` mounted in the shipped order, and creates its approval through the real invoke route rather than by writing a row, so the probe exercises the path that ships. That is the same construction `checkDecisionAuthorityConformance`'s probe already uses; copy it rather than inventing a second harness.

**"The credential code" is not a placeholder, and the two 403 codes must differ.** `agent-api-key` is refused by the header check; `agent-api-key-without-identity-header` and `person-api-key` can only be refused by the credential check (§3.3). If all three answered the same code, then deleting the credential check would leave `agent-api-key` answering identically through the header check, and **the probe would stay green while the thing it exists to prove was gone**. That is an assertion that cannot fail sitting inside a security probe. Pin the distinct code the implementing PR chooses, so removing the credential check turns the rows that depend on it red and leaves the header row alone.

**These rows depend on the check order §3.3 requires, and that dependency is the reason it is a requirement.** The table assigns `agent-api-key` the header code and the other two the credential code, which is only true because the identity-header check answers before the credential check (`decision-authority.ts:152-159`, ahead of the posture branch). Put the credential check first and every API-key row collapses to one code, at which point the header check becomes undeletable-without-detection in exactly the way this section exists to prevent. So the ordering is not a free implementation choice that the table quietly assumes: it is stated in §3.3, it matches what ships, and a build that reorders it fails this table rather than silently weakening it.

`agent-api-key-without-identity-header` is the reported defect, verbatim.

**Test the test.** Seeded regressions, each asserted to fail the checker, and each asserted to fail the **specific** rows named:

- Delete the credential check. `agent-api-key-without-identity-header` and (in phase 0) `person-api-key` must go red; `agent-api-key` must stay green, which is what proves the header check is not covering for the missing one.
- Make the cookie guard return "allowed" unconditionally. Every API-key row must go red.
- In phase 2, flip `classifyApiKeyScope` to always return `person`, and exactly the two agent rows must fail. Plus a table-driven unit test of `classifyApiKeyScope` over `null`, the agent shape, and an unrecognized non-null value.

A seeded regression is not optional here. `.claude/rules/testing.md` now carries "Assertions that cannot fail", eleven shapes catalogued after eleven green checks certified false things in one day. A conformance table whose rows all pass on day one is that shape until someone proves a row can go red.

**What this proves.** After phase 0: on an instance with login on, the approval decide routes refuse a request whose credential is an API key of any kind, whether or not it also presents an identity header, and a refusal leaves the approval pending and decidable. After phase 2: the same, except that a person-scoped key decides, so the proof narrows to "a key DorkOS minted for an agent cannot decide". Cite whichever one has actually shipped, not the one further down the page.

**What this does not prove.** Stated here so nobody cites it for more:

- Nothing about the `local-trust` posture. With login off there is no credential to classify and every probe would be vacuous. This is not a proof that agents cannot approve their own actions in DorkOS; it is a proof about instances with login on.
- Nothing about how an agent came to hold a credential. An agent that reads the operator's own key off disk presents a person-scoped key and passes. The probe pins what DorkOS's own credential can do, not what an agent can obtain.
- Nothing about surfaces not in the list. It covers the two decide routes. A future approvals MCP tool, capability, or bulk endpoint is unproven until someone adds it here, exactly like the hand-maintained choke-point list ADR 260725-133220 already records as a negative consequence.
- Nothing about keys written outside DorkOS's minting path. A row inserted directly gets `permissions: null` and classifies as a person's key, deliberately (§3.6).

### 3.9 The posture lock: shipped, and this section is now a record

**Nothing to build here. Do not implement this section.** It was a task on 2026-07-25 and it is a description on 2026-07-27, kept because the reasoning is why the rest of the spec is worth writing.

The problem it named: `operator.config_patch` is tier `act`, so it needs no approval, and `applyConfigPatch` used to deep-merge anything that validated against `UserConfigSchema`. `auth.enabled` is an ordinary schema field, so a caller on the capability surface could turn login off and make every credential check in this spec unreachable.

What actually shipped is broader and better than the `POSTURE_CONFIG_KEYS` set this section proposed, so implementing the proposal now would be a **regression**:

- `services/core/operator/config-write-policy.ts` (#469, DOR-488) classifies **every** leaf of `UserConfigSchema` as `agent-writable` or `operator-only`, with a drift guard in `__tests__/config-write-policy.test.ts` that fails the build when a new config field carries no verdict. `auth.enabled` is `operator-only`, alongside `tunnel.*`, `mcp.*`, `telemetry.*`, `extensions.*`, the credential references, and the path fields that widen what DorkOS may touch.
- `createConfigPatchHandler` refuses a patch touching any of them, naming the offending paths and telling the model to ask the person (`describeOperatorOnlyRefusal`).
- `PATCH /api/config` runs the same guard (#476, DOR-467) plus a cookie bar under login-on (#486, DOR-505) at `routes/config.ts:253` and `:286`. Without that second one, a key minted by §3.4 could still have turned login off through the REST route, which was the sharpest finding in this branch's review.
- The guard sits at the capability handler and at the route, **not** inside `applyConfigPatch`, for exactly the reason this section gave: the cockpit's own enable-login and disable-login flows reach the same function and must keep working.

The residual those PRs state, and this spec inherits: with login **off** there is no cookie for anyone, so the cookie bar allows and only the agent bar is left. A program on the machine that omits its agent header can still write every `operator-only` setting. That is the same posture §3.7 scopes out.

### 3.10 The card says who asked

`requesterLabel` returns `undefined` for a caller with no identity, and the card reads "An unidentified caller" (`tier-enforcement.ts:535`, `:547`, used at `:782`). With an agent-scoped credential present, DorkOS knows more than that even without the header: it knows a non-person asked.

When the request carries an agent-scoped credential and no resolved identity, the card says so ("An agent asked, but it did not say which one") rather than "An unidentified caller". This is small, and it is the surface where the defect would have been visible to a person: an approval card that says an agent asked, arriving at the same moment nobody clicked anything, is the tell.

Threading the credential scope into `enforceCapabilityTier` follows the existing `TierEnforcementRequest` options-object shape (the delta already recorded in `specs/agent-trust/04-implementation.md:15`). The gate's decision does not change: tier still decides, per ADR 260725-133220. Only the summary text does.

## User Experience

For the operator, almost nothing changes and one thing gets better. Agents that DorkOS runs keep working when login is on, and keep working past the tenth command. The operator no longer needs to copy their own key anywhere for agents to work. Settings > Security shows which keys belong to agents. Approval cards say an agent asked when an agent asked.

The one visible change: if an operator had been driving approvals from a script using a key they placed for an agent, and that key is now agent-scoped, the script gets a 403 with a message saying approvals are decided by a person. That is the intended behavior, and it only affects keys DorkOS minted, never one the operator created.

## Testing Strategy

**Unit.** `classifyApiKeyScope` over `null`, the agent shape, and an unrecognized non-null value. `verifyRequestAuth` returning `credential: 'cookie'` for a cookie and `'api-key'` with the right scope for each key kind, including a key whose verify comes back `valid: false` with `RATE_LIMITED` (returns `null`, 401). The minting helper: no `DORKOS_API_KEY` when login is off, correct server-only fields when it is on, plaintext never logged, spawn proceeds on minting failure. `resolveDecisionAuthority` over an agent-scoped user, in both postures.

**Integration.** The five decide-route cases from §3.8, driven through the real app. `POST /api/approvals/:id/grant` with an agent-scoped key leaves the approval listed by `GET /api/approvals/pending`. The full defect walked end to end: destructive invoke returns 202, the same credential is refused at grant, a cookie grants it, the retry with the token succeeds.

**The four observable `trustedCaller` sites (§3.3).** An agent-scoped key is no longer a trusted caller at `routes/marketplace.ts:302` and `:343` and `routes/tasks.ts:158` and `:266`. Four cases that go red without the change. The other two sites (`routes/config.ts:319`, `routes/extensions-approval.ts:120`) sit behind a cookie bar that already refuses an API-key caller, so a case there would pass either way: assert instead that the cookie bar answers first, which is the thing a later reordering would break.

**A real mint, not a mocked one.** At least one test drives `auth.api.createApiKey` against a real Better Auth instance with the exact body §3.4 specifies, and asserts the key comes back. A mocked mint cannot catch a unit error in `expiresIn`, and "failure is not fatal" means such an error is invisible everywhere else.

**Conformance.** `checkCredentialScopeConformance` wired into the existing `capabilityConformance` describe block, with the seeded regressions asserted to fail the **specific** rows §3.8 names. "Fails the checker" is not enough on its own: a regression that reddens every row proves the harness runs, not that the credential check is the thing being tested.

**Phase 0's own cases, which are not the same as phase 2's.** While the cookie bar stands alone, `person-api-key` is refused. A test written against phase 2's expectations goes red on the code that ships first, and a test that asserts phase 2's outcome and passes during phase 0 is asserting the wrong subject. Both tables are in §3.8; use the one matching the build.

**Rate limit.** A regression test that an agent-minted key survives more than ten consecutive verifications. The reproduction that a cockpit-created key does not is the first step of its own ticket, not a task here.

No posture-lock tests: it shipped, with its own (§3.9).

**Redaction.** Extend the existing fixture that covers `DORKOS_AGENT_TOKEN` to cover `DORKOS_API_KEY`.

## Performance Considerations

`verifyRequestAuth` gains two field assignments and one Zod parse of an already-fetched JSON object. No new query, no new round trip; `permissions` comes back on the verify result that is already being made. Minting is one insert per agent spawn, and only when login is on. The expired-key sweep piggybacks the existing maintenance cadence. Turning off the plugin's rate limiting for agent keys removes a per-request DB write path for those keys (`index.mjs:1718-1733` writes `requestCount` / `lastRequest` on every verify in database storage mode), so agent traffic gets slightly cheaper, not more expensive.

## Security Considerations

The residual limit is stated in §3.7 and is the most important sentence in this document: on a machine where agents run as the operator's OS user, credential scoping makes self-approval unnecessary and visible, not impossible. Anything claiming more than that is wrong.

Beyond that: key material is returned once by the plugin and goes straight into a child process environment, never to disk and never to a log. An agent-scoped key cannot mint a better one, verified twice over in the installed plugin (`enableSessionForAPIKeys` defaults to `false` at `index.mjs:2285`, and `createApiKey` requires a cookie session for any client request at `:733`, `:749-754`; the plugin never reads `Authorization: Bearer` at all). The scope field is server-only-writable at create and at update, so a cookie session cannot promote an agent key or demote its own. `MCP_API_KEY` and the local MCP token are not accepted by `sessionGate` and therefore cannot reach the decide routes.

**This spec introduces a credential, so it owes an account of what that credential can reach.** An agent-scoped key passes `sessionGate`, which means it reaches the whole `/api/*` surface, including `PATCH /api/config`. Under login-on, the write policy plus the cookie bar (§3.9) already refuse it every `operator-only` path, `auth.enabled` first among them, so it cannot turn off the posture that makes its own scope check run. That was not true when this spec was written and is the single most important thing the intervening PRs changed. If either of those two bars is ever loosened, this spec's invariant goes with it, and a comment at the minting site should say so.

Fail-closed choices: an unrecognized non-null `permissions` value classifies as `agent`; a refused decision never touches the approval; a failed mint degrades to today's behavior rather than to an unscoped credential.

## Documentation

- `docs/guides/cli-usage.mdx` - rewrite the "If your DorkOS asks you to sign in" section. It currently recommends the key file **because** agents inherit it (`:273`). That sentence goes. New framing: the key file is for your own shell; agents DorkOS runs get their own key and need nothing from you.
- `docs/self-hosting/securing-your-instance.mdx` - explain the two kinds of key and which one can approve.
- `docs/self-hosting/threat-model.mdx` - state the §3.7 residual limit plainly, in the same place it already describes the local trust model (`:63`).
- `docs/guides/action-approvals.mdx` - it already tells people that turning on Require login is what makes approvals enforceable. Add that a key DorkOS gave an agent cannot answer an approval, and that a key they made for themselves can.
- `contributing/authentication.md` - the authority table from §3.1, the scope field, and the minting seam.
- `contributing/agent-operator-surface.md` - it already carries the "signed-in-operator verifies a CREDENTIAL, not a human" paragraph citing DOR-474. That paragraph is what this spec makes obsolete, so updating it is the closing act, not an afterthought.
- Changelog fragment per PR, at the `writing-for-humans` bar.

No entry in `contributing/configuration.md`, because no config field is added (see Open Questions).

## Implementation Phases

Three phases now, because the cookie bar was pulled ahead of the rest (Open Questions).

**Phase 0 - close DOR-474 with a cookie bar.** Being implemented separately, tracked on DOR-474 itself. Deciding an approval requires `credential === 'cookie'` under login-on. Nothing in this spec is a prerequisite, and DOR-474 is closed when it lands.

Two things about it are the implementer's choice and one is not.

- **Choice: where the bar sits.** Inside `resolveDecisionAuthority`, which extends it to the act-without-approval paths (§3.3), or at the decide routes alone. Choose deliberately and record which.
- **Choice: the credential refusal's code and message**, subject to being distinct (§3.3) and pinned in §3.8's table.
- **Not a choice: the order.** The identity-header check answers before the credential check, and each answers a distinct code (§3.3). Either placement above can honour this and the shipped code already does (`decision-authority.ts:152-159`), so this constrains nothing anyone wants to do. A placement that cannot preserve distinct codes in a fixed order is not an acceptable option, because it makes §3.8's probe unable to detect the deletion of either check.

Phases 1 and 2 then deliver what the cookie bar does not: an agent that never needs the operator's key, a key that survives past ten calls a day, and a credential DorkOS can name on an approval card. **Neither phase may be described as closing the self-approval hole; phase 0 does that.** The demo-claim gate applies to security properties too.

**Phase 1 - make an agent's credential its own.**

1. `classifyApiKeyScope` and the shared Zod shape (§3.2).
2. Server-side minting at the spawn seam, with `permissions`, `rateLimitEnabled: false`, `userId`, `expiresIn` in seconds (§3.4), plus revocation, sweep, and the real-mint test.
3. Redaction fixture extension.

**Phase 2 - make the distinction mean something.**

4. `scope` on `RequestUser` (§3.2). `credential` already shipped in DOR-505.
5. The scope refusal, alongside phase 0's cookie bar rather than instead of it (§3.3). This is what lets a person-scoped key decide again, so it **widens** what phase 0 allows, and the four observable `trustedCaller` sites move with it.
6. `CredentialScopeProbe`, `DECIDING_CREDENTIALS`, `checkCredentialScopeConformance`, and the seeded regressions (§3.8), including moving the `person-api-key` row from the phase 0 table to the phase 2 one.
7. Security-panel scope labels (§3.6) and the approval-card wording (§3.10).
8. Docs and changelog.

**Two items left this list and became follow-ups, and the renumbering above is why.** They were phase 1 tasks 1 and 2 when the decide refusal depended on minting. Phase 0 removed that dependency, so neither of them blocks anything here and neither should sit in a queue behind work it does not need. Both are below.

The posture lock is no longer a task. It shipped in #469, #476 and #486 (§3.9).

## Follow-ups

Two tickets, each independent of the phases above. Neither blocks phase 0, phase 1 or phase 2, and neither is a prerequisite for any of them.

**1. The ten-per-day rate limit on cockpit-created API keys.** `apiKey()` is configured with zero options (`services/core/auth/index.ts:138`), which resolves `rateLimit: { enabled: true, timeWindow: 86400000, maxRequests: 10 }` and writes those as concrete columns onto every key the cockpit creates. Every `verifyApiKey` burns one, and the CLI presents its key on every call. If that is what actually happens, an agent doing real work through the CLI with login on gets about ten requests and then starts failing with "this DorkOS instance did not accept your API key", which breaks the credential path agents depend on whenever login is on. **This is unverified.** It was traced in the installed plugin source, with the citations in §3.4, and never reproduced against a running server: that reproduction was this spec's own phase 1 task 1 and it was never done. **Verifying it is the first step, and the ticket should not propose a fix before the reproduction exists.** If it reproduces, it is a live defect and a small one to fix. If it does not, the finding is retired and the §3.4 citations say where to look next. Either way it is independent of approvals and does not wait for phase 2, which the Open Questions caveat below already states.

**2. OpenCode has no agent-identity seam.** `resolveAgentTokenEnv` (`services/core/agent-identity/agent-token-env.ts:42`) has two production call sites, `services/runtimes/claude-code/messaging/message-sender.ts:399` and `services/runtimes/codex/codex-runtime.ts:484`. Nothing under `services/runtimes/opencode/` calls it, so an OpenCode agent carries no `DORKOS_AGENT_TOKEN` and is unattributed everywhere attribution is read. OpenCode is in this spec's own premise, so this is a gap in the identity story regardless of credentials. It is a change to attribution rather than authorization, and §3.4 has the reasoning for shipping and reviewing it on its own.

**Minting an agent's own key is not a follow-up.** It is phase 1 tasks 1 through 3 above, and it stays there. It needs no separate ticket, and nothing outside these phases should be described as waiting on it.

Decomposition in `03-tasks.json`.

## Open Questions

- ~~Should the scope live in `metadata` or `permissions`?~~ **(RESOLVED)** `permissions`. It is the only per-key field the installed plugin refuses to let a cookie-session client write, at create (`index.mjs:734-736`) and at update (`index.mjs:1481-1487`). `metadata` is client-writable whenever `enableMetadata` is on and is silently dropped when it is off, so it cannot carry authority.
- ~~Should DorkOS pass `permissions` to `verifyApiKey` and let the plugin authorize?~~ **(RESOLVED)** No. That path rejects any key with null stored permissions as `KEY_NOT_FOUND` (`index.mjs:1664-1668`), which is every key that exists today. DorkOS reads the value back and classifies it itself, so the rule is ours and is testable.
- ~~What is an unscoped legacy key?~~ **(RESOLVED)** Person-scoped. Reasoning and the operator's recommended follow-up in §3.6. The alternative breaks a person's own CLI approval flow with an error blaming an agent, which is a security change nobody keeps.
- ~~Does this need a config field, and therefore a semver-keyed migration?~~ **(RESOLVED)** No, on both counts. The scope lives on the `apikey.permissions` column, which already exists in the schema (`packages/db/src/schema/auth.ts:130`) and in applied migration `0022` (`:40`), so there is no database migration either. The posture is the existing `auth.enabled`. A knob such as "require a cookie to approve" would be a dial whose only settings are the safe default and something less safe, so it is not offered. If a later round does add a field, it follows `contributing/configuration.md` and the `adding-config-fields` skill: append-only migration keyed to the release version, guarded by `store.has()`.
- ~~Should the two credentials be collapsed into one?~~ **(RESOLVED)** No. Reasoning in §3.5. Revisit if login-on ever becomes the default posture.
- **(OPEN)** Does the Better Auth **client** SDK's `listApiKeys` response type surface `permissions`? The endpoint parses and returns it (`index.mjs:1323`), but the client type was not verified. If it does not, the Security panel needs a small server-side projection instead. Resolve during phase 2, task 7 (the Security-panel scope labels).
- ~~Should deciding require a session cookie, refusing every API key?~~ **(RESOLVED 2026-07-27, by Dorian: yes, and scoping becomes phase 2.)** Resolved No on 2026-07-25, on the grounds that cookie-only forecloses a headless operator and a future `dorkos approve` verb while buying nothing today. The grounds are intact. What changed is the price.

  **Cookie-only costs nothing today, which was the open unknown.** Every first-party client already authenticates with a cookie: the client transport layer sends `credentials: 'include'` throughout (`apps/client/src/layers/shared/lib/transport/http-client.ts:37`, and the mesh, relay and room methods beside it), and no `Authorization` header is constructed anywhere in the client, desktop, or Obsidian surfaces outside the settings snippet generator that prints config for **external** MCP clients (`layers/features/settings/lib/external-mcp-snippets.ts`). So cockpit, Electron, and Obsidian-over-HTTP all keep deciding approvals. Nothing first-party breaks.

  **And the repo had already chosen it twice**, both times approvals-adjacent: opening a standing permission (`requireOperatorCookie`, `routes/approvals.ts:382`) and writing any `operator-only` setting under login-on (`requireOperatorCookieUnderLogin`, `routes/config.ts:286`). A weaker rule for the one-time decide route than for the standing one is not a design, it is a gap nobody had gotten to.

  So: **the cookie bar ships first and closes DOR-474.** Per-key scoping stays specified and becomes phase 2, because it is strictly more expressive: it is what lets a headless operator and a `dorkos approve` verb exist, and it is what produces the §3.10 card wording and the §3.6 Settings labels.

  Three things on the record, so the next reader does not have to rediscover them:
  1. **Cookie-only does not subsume the rate-limit defect.** A cockpit-created key dying after ten verifications a day is an independent shipped bug (§3.4). It needs its own ticket and it does not wait for phase 2.
  2. **It forecloses §3.10 and the Settings scope labels** until phase 2. DorkOS cannot say "an agent asked" on a card without a way to tell an agent's credential apart, and cannot label a key it cannot classify. Real, and small.
  3. **Where the bar goes is a decision, not an inheritance.** Putting it inside `resolveDecisionAuthority` gives it the same reach §3.3 describes, so an operator's own script holding an API key would also lose the `marketplace.ts` and `tasks.ts` act-without-approval paths. That may be right, since "whoever may decide may act without one" is the invariant those paths rest on. But it follows from the placement rather than from the goal, so whoever implements it should choose the placement deliberately and say which they chose and why. **The check order is not part of that choice:** the identity-header check answers first and each check answers a distinct code, whichever placement is taken (§3.3, and see Implementation Phases).

## Related ADRs

260725-133220 (the action's tier decides the gate; identity only caps it - this spec extends the same reasoning to the decide side, where a caller-chosen header is still the only check), 260725-133221 (an approval binds to the exact action the person saw - unchanged; this spec constrains who may make the decision, not what the decision covers), ADR-0315 (raw secrets never live in `config.json`, which is why the CLI key sits in its own file), 260725-152018 (the agent-facing config snapshot is an allowlist; the write-side counterpart is `config-write-policy.ts`, which shipped in #469).

Candidate ADR to extract on completion: "an API key carries a scope, and an agent's key cannot decide". The second candidate this spec once listed, "the trust posture is not tool-writable", belongs to whoever extracts ADRs from #469 / #476 / #486, not here.

## References

- `apps/server/src/services/core/auth/session-gate.ts` (the gate, `verifyRequestAuth`, `RequestUser`)
- `apps/server/src/services/core/approvals/decision-authority.ts` (who may decide, and the residual it already names)
- `apps/server/src/lib/caller-authority.ts` (the request reader, and the cookie bars)
- `apps/server/src/routes/approvals.ts` (the decide routes)
- `apps/server/src/services/core/agent-identity/agent-token-env.ts` (the spawn seam, and its two runtime call sites)
- `apps/server/src/services/core/capabilities/tier-enforcement.ts` (the request side of the gate)
- `apps/server/src/services/core/operator/config-write-policy.ts` (the write allowlist that closed the posture escalation)
- `packages/cli/src/lib/api-client.ts` (the CLI credential path)
- `packages/test-utils/src/capability-conformance.ts` (the pattern the new probe follows)
- `node_modules/@better-auth/api-key@1.6.23/dist/index.mjs` (every plugin claim above)
- `specs/agent-trust/02-specification.md` §3.1-3.3 and `04-implementation.md`
