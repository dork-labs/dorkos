---
slug: agent-approval-settings
id: 260726-015631
created: 2026-07-25
status: specified
---

# Agent approval settings: a supported way to say "stop asking"

**Status:** Proposed
**Author:** Ceres (directed by Dorian)
**Date:** 2026-07-25
**Tracker:** DOR-501
**Project:** Agents as First-Class Operators (phase 4)

## Overview

Give the operator an explicit, findable way to let a named agent do a named thing without being asked every time, bounded by a clock, revocable in one click, and recorded either way. The setting is its own control, not a side effect of the runtime permission mode. Creating one requires a signed-in person, which is what stops an agent granting itself trust and which means **standing permissions require Require login to be on** (§3.0). It replaces the undocumented `MARKETPLACE_AUTO_APPROVE` environment variable, which is deleted.

## Background / Problem Statement

DorkOS gates destructive capabilities behind a human approval. As of DOR-467 that gate lives **inside `registry.invoke`** (`apps/server/src/services/core/capabilities/registry.ts:387`), which is a better foundation than the per-adapter arrangement it replaced: "every surface that reaches a capability through the registry is gated by construction. It used to be called by each transport adapter instead, which made a surface gated exactly as long as somebody remembered to gate it" (`apps/server/src/services/core/capabilities/tier-enforcement.ts:10-13`). `enforceCapabilityTier` now has exactly one call site.

That matters directly for this spec: **the grant lookup goes inside the gate, so it inherits every surface for free**, including the legacy marketplace routes that DOR-467 pulled in. There is no per-surface wiring to remember and no list to keep current.

There is still no supported way to turn the gate off. The only bypass in the tree, `MARKETPLACE_AUTO_APPROVE` (`apps/server/src/env.ts:44`, read once at `apps/server/src/index.ts:1592`), is scoped to tests by its own docstring, absent from `.env.example` and the docs, and does not touch the tier gate at all.

The full argument, the options weighed, and the verification behind each claim are in `01-ideation.md`. Three facts from it drive this design:

1. **Exactly one capability in the server is `destructive`**: `marketplace.uninstall` (`apps/server/src/services/marketplace-mcp/marketplace-capabilities.ts:238`). `marketplace.install` (`:216`) and `marketplace.create_package` (`:265`) are tier `act`, so the tier gate never gates them. What stops those is the marketplace's own older confirmation step. **Two mechanisms make a user wait, so one setting has to satisfy both** or "stop asking" will silently keep asking.
2. **Per-agent trust cannot live in `agent.json`.** The manifest on disk is canonical and the reconciler syncs file to DB every five minutes (`packages/mesh/src/reconciler.ts:114-135`, direction stated at `:197`; cadence `packages/mesh/src/mesh-core.ts:391`, wired at `apps/server/src/index.ts:804`). There is no checksum, signature, or integrity check on the manifest anywhere. An agent that can write a file would trust itself within five minutes.
3. **There is no per-agent permission mode.** It is a property of a session (`packages/db/src/schema/sessions.ts:22`), a channel binding, and a scheduled task (`packages/db/src/schema/tasks.ts:16`). This changes where the two settings can be shown together; see §3.7.

## Goals

- An operator can say "stop asking about this agent doing this thing" and have it hold, for a bounded time.
- The setting is explicit and separate from runtime permission mode, and the two are never confused for each other in the UI.
- No agent can turn the gate off for itself, through any capability, tool, or route. Making that true of **routes** (not just capabilities) is what forces standing permissions to require login; see §3.0.
- Every action that proceeds without a card is still recorded, in the place users already look.
- Every standing permission is findable and revocable from one place, without hunting.
- `MARKETPLACE_AUTO_APPROVE` is gone, with all eight of its references migrated onto production code paths (§3.9).

## Non-Goals

- Wiring `bypassPermissions` or any other permission mode into the tier gate. This is forbidden by design; §3.8 makes it a tested invariant rather than an absence.
- Bringing new surfaces under the gate. Scheduled tasks, relay, mesh, and extensions stay ungated, exactly as `docs/guides/action-approvals.mdx:65-71` already tells users.
- Setting `tierCeiling` below `destructive`. The column exists and is read, but nothing writes a lower value today; that stays true after this change.
- Remote or mobile approval delivery.
- Any "trust this agent for everything" control. The schema deliberately has no wildcard.

## Technical Dependencies

Internal only: the capability tier gate and approval primitive from spec `agent-trust`; `ApprovalService` and `resolveDecisionAuthority` (`apps/server/src/services/core/approvals/`); the `conf`-backed user config and its two classification tables (`config-disclosure.ts`, `config-write-policy.ts`); the Activity feed and its two observers; the global SSE fan-out; the marketplace `ConfirmationProvider` seam; `packages/evals` and its `approvalPolicy` mechanism.

## Detailed Design

### 3.0 Standing permissions require login, and why that is not a compromise

**The problem this section closes.** An earlier draft of this spec claimed no agent could turn the gate off for itself "through any capability, tool, or route". The word _route_ made it false, and the hole is big enough to sink the feature.

`findOperatorOnlyPaths` is enforced at two places, and only one of them is unconditional. `operator-tool-handlers.ts:211` always runs it. But `routes/config.ts:232` sits inside `if (!trustedCaller(readCallerAuthority(req, res)))` (`routes/config.ts:231`), so a caller that clears `trustedCaller` skips the policy check entirely. `trustedCaller` (`trusted-caller.ts:134`) is just `resolveDecisionAuthority` in a wrapper, and under the default `local-trust` posture that resolver allows any caller presenting neither an agent header nor an approval token (`decision-authority.ts:172-174`). An agent need only omit two headers.

The route's own comment already admits this, calling the divergence "accepted, not overlooked" because "the cockpit needs this route and `local-trust` cannot tell it apart from anything else on loopback" (`routes/config.ts:221-223`). That was a defensible trade when the worst case was one config write. It stops being defensible here.

The chain, all of it on the default posture:

1. `PATCH /api/config {"approvals":{"standingGrants":true}}` with the agent header omitted. `trustedCaller` is satisfied, the operator-only check is skipped, the value is written.
2. The agent invokes the destructive capability **with** its identity, so the approval records its own agent path. It gets back an approval id.
3. `POST /api/approvals/:id/grant {"standing":true}` with both headers stripped. Authorization is `resolveDecisionAuthority` (`routes/approvals.ts:79-80`) and the approval is identified by **URL id** (`routes/approvals.ts:166`), never by token, so dropping the token costs the caller nothing.
4. Every later identified call matches the grant and is auto-approved, silently, for the whole window.

**Why this blocks rather than being an inherited residual.** Today a header-stripping caller gets one action at a time, each leaving an approval row and an Activity record. After this feature it gets a renewable window of silent auto-approval. The feature does not create the hole; it converts a noisy one-shot into a quiet standing one. That is an amplification the spec has to answer for.

**The rule.** Creating or extending a standing permission, and writing anything under `approvals.*`, requires a **session cookie**. Not the weaker "cleared `resolveDecisionAuthority`" bar, which is exactly what the chain above clears. A cookie is the only signal that separates the cockpit from a header-stripping loopback caller, and under `local-trust` there is nothing else to appeal to. Inventing a weaker marker would be the lie `decision-authority.ts:40-42` explicitly refuses to tell.

**The consequence, stated rather than hidden: standing permissions require `auth.enabled`.** With login off there is no cookie, so there is no way to tell the operator from an agent on the same machine, and "trust this agent" is not a statement the system can evaluate. Better to say that plainly than to ship a control that appears to distinguish callers it cannot distinguish.

**One piece of plumbing this needs: three edits.** `RequestUser` carries only `userId` today (`session-gate.ts:40-43`), so which credential produced it is not recoverable downstream. The change is the interface field plus both value-returning sites, which `verifyRequestAuth` already has separated: the cookie returns at `session-gate.ts:98`, the API key at `session-gate.ts:114`. Each return gains a `credential: 'cookie' | 'api-key'` value.

Nothing else in the repository constructs a `RequestUser` object literal, so adding a required field breaks no call site and no test. That is what makes it safe to make the field required rather than optional, and required is what matters: an optional field defaults to `undefined`, and a cookie check that reads `undefined` as "not a cookie" would be correct by accident rather than by type.

This also closes the login-on residual `decision-authority.ts:25-32` names, where a program holding a per-user API key and shedding its agent header satisfies every existing check.

**Behavior with login off**, specified so it cannot be quietly softened into something that looks like it works:

- The Security panel shows the control, **visible but disabled**, with a plain reason: standing permissions need Require login turned on, because without it DorkOS cannot tell you apart from an agent running on this machine. The panel already hosts the enable-login flow, so the fix is one click away.
- The approval card's third button does not render at all. Offering a button that will be refused is worse than not offering it.
- Server-side, both paths refuse independently of the UI, with code `standing_grants_require_login`. The UI state is a courtesy; the refusal is the guarantee. A guard that lived only in the client would be the same "true because a field is absent" pattern §3.8 exists to eliminate.
- **Turning login off revokes every live grant**, exactly as turning the master switch off does, and the disable-login confirmation says so. Leaving grants dormant across a posture change would let them wake up later under a posture that can no longer justify them.

**Scope note.** This spec makes `approvals.*` cookie-only. It does **not** fix the general `trustedCaller` divergence at `routes/config.ts:231` for the other operator-only paths (`auth.enabled`, `tunnel.*`, `mcp.*` and the rest), which is real, is already reproduced, and belongs to DOR-505 rather than here. Filed separately; named here so it is not mistaken for something this spec closed.

### 3.1 The setting, in user config

Two new leaves in `UserConfigSchema` (`packages/shared/src/config-schema.ts`), in a new `approvals` section:

```ts
approvals: z
  .object({
    /** Whether standing permissions may exist at all. Off by default. */
    standingGrants: z.boolean().default(false),
    /** How long a new standing permission lasts, in minutes. */
    trustWindowMinutes: z.number().int().min(5).max(1440).default(480),
  })
  .default(() => ({ standingGrants: false, trustWindowMinutes: 480 })),
```

`standingGrants` defaults to `false`. A safety feature does not get quietly relaxed by an upgrade: nothing changes for an existing user until they ask for it.

`trustWindowMinutes` is bounded in the schema. The maximum of 1440 (one day) is what makes "forever" unrepresentable, and the minimum of 5 keeps the window from becoming a deny-all that looks like a broken feature, which is the reasoning already applied to the approval window at `apps/server/src/services/core/approvals/approval-service.ts:66-75`.

**Classification, both leaves:**

- `CONFIG_WRITE_POLICY` (`apps/server/src/services/core/operator/config-write-policy.ts:120`): both `operator-only`. They sit exactly on the line that module states, "changing it, on its own, removes or widens a security control" (`:49-50`). An agent patch touching either is refused whole by `findOperatorOnlyPaths` (`:332`).
- `CONFIG_DISCLOSURE` (`apps/server/src/services/core/operator/config-disclosure.ts`): both `expose`. Neither is a credential nor points at one. They describe a posture, and an agent being able to read "standing permissions are switched off here" is useful and harmless.

Both tables carry drift guards that fail the build when a new leaf has no verdict, so this classification is enforced rather than remembered. The write-policy table's own doc comment states it (`config-write-policy.ts:112-115`), and the guards are `apps/server/src/services/core/operator/__tests__/config-write-policy.test.ts` and `.../config-disclosure.test.ts`.

**`operator-only` is necessary here but not sufficient**, which is the whole of §3.0. That verdict is enforced unconditionally on the capability surface (`operator-tool-handlers.ts:211`) but only conditionally on the HTTP route (`routes/config.ts:231-232`), where a caller that clears `trustedCaller` skips it. So `approvals.*` carries a second requirement on top: a patch touching it needs a **session cookie**, checked in `routes/config.ts` before the existing `trustedCaller` block and regardless of its outcome.

This is expressed as a small named list, `REQUIRES_COOKIE_CONFIG_PATHS`, covering the `approvals` subtree, with a drift guard asserting every leaf under `approvals` in `UserConfigSchema` appears in it. Deliberately scoped to this one subtree rather than generalized: extending the cookie requirement to the other `operator-only` paths would change behavior for flows this spec has not examined, and it belongs to DOR-505.

**`REQUIRES_COOKIE_CONFIG_PATHS` is meant to be temporary, and this is the note that says so.** DOR-505 closes the header-stripping residual for operator-only config writes generally. When it lands, this list becomes redundant for every path it covers, and it should be **deleted**, not left in place as a second overlapping check on the same writes. Whoever implements DOR-505 owns removing it and folding `approvals.*` into the general rule. Recorded here because the way parallel mechanisms survive forever is that nobody ever wrote down that one supersedes the other, and this repo does not tolerate that.

> **Resolved by DOR-505, partly.** DOR-505 gave the cookie requirement to every `operator-only` path, but only in the login-**on** posture: with login off there is no cookie for anyone, and requiring one would lock a person out of their own settings, so that half of the residual stays open and is now stated in the route, in `contributing/configuration.md`, and in `docs/guides/action-approvals.mdx`. The cookie half of this list was therefore deleted as predicted. The list itself survives, renamed `REQUIRES_LOGIN_CONFIG_PATHS`, carrying the one thing the general rule does not reach: `approvals.*` may not be written at all while login is off. That is not the same check restated: the general rule allows any caller in that posture, so without this list the write would go through. It is a **forward-looking** guard rather than a fix for a live escalation, and the distinction is the whole reason it survives being read later. A write to `approvals.standingGrants` today changes no behavior at all: nothing enforces a standing permission yet, `ApprovalGrantService.findLive` has no production caller, and the grant route refuses `standing: true` for every caller. What makes it worth guarding is that the write persists and nothing sweeps it (`revokeStandingGrantsIfPostureNarrowed` only fires on a narrowing), so an agent could set the switch now and have it still set when enforcement ships. Anyone who tests the attack today will find it inert; that is expected, and is not grounds to delete the guard. Two bars that compose, not two that overlap.

One thing DOR-505 does **not** remove: the requirement that grant creation itself needs a cookie (§3.5). That is a property of the approvals routes, not of the config write path, and it stands on its own.

**What is deliberately NOT in config:** the grants themselves. They are operational state with a creation time, an expiry, and a revocation, and spec `agent-trust` already resolved this exact shape: "Approval persistence? **(RESOLVED)** SQLite table (derived data, not user-owned files)" (`specs/agent-trust/02-specification.md:97`). Keeping them out of config has a second benefit: nothing about _which_ agents are trusted can ever leak through `config_get`.

**Migration.** Per the `adding-config-fields` skill, an idempotent entry appended to `CONFIG_MIGRATIONS` (`apps/server/src/services/core/config-manager.ts:844`):

```ts
'<next-release>': (store) => {
  if (!store.has('approvals')) {
    store.set('approvals', { standingGrants: false, trustWindowMinutes: 480 });
  }
},
```

The key is authored on a placeholder resolved to the real release at tag time by `/system:release`, which is the practice the existing block comment above the `'0.45.0'` entry documents. `conf`'s defaults-merge already populates an added-with-default key, so this body is a guard that anchors the version boundary. Both docs mirrors (`contributing/configuration.md` and `docs/getting-started/configuration.mdx`) get a row, and `apps/server/src/services/core/__tests__/config-manager.test.ts` gets a stale-config upgrade-path test.

### 3.2 The grants store

A new table in `packages/db/src/schema/`, `approval_grants`:

| Column                   | Notes                                                        |
| ------------------------ | ------------------------------------------------------------ |
| `id`                     | ULID, primary key                                            |
| `agentPath`              | the agent this covers, indexed                               |
| `capabilityId`           | the one action this covers                                   |
| `grantedAt`, `expiresAt` | ISO 8601 UTC                                                 |
| `grantedBy`              | the `decidedBy` label from `resolveDecisionAuthority`        |
| `posture`                | `signed-in-operator` or `local-trust`, recorded per decision |
| `sourceApprovalId`       | the card it came from, or null when created in Settings      |
| `revokedAt`              | null while live                                              |

Keyed on `agentPath`, not on an identity token. Tokens are minted fresh on every spawn (`apps/server/src/services/core/agent-identity/agent-token-env.ts:52-55`), so a token-keyed grant would evaporate the next time the agent started. The identity table's primary key is `tokenHash` (`packages/db/src/schema/agent-identity.ts:37`), not `agentPath`, so this is not a shape that table already uses. It rests on its own reasoning, which that table's own comment supports: an agent has many concurrent tokens, and "revocation is therefore an `agentPath`-wide sweep, not a single-row delete" (`packages/db/src/schema/agent-identity.ts:30-31`). `agentPath` is what survives a respawn, so it is what a grant has to be keyed on.

`ApprovalGrantService`, alongside `ApprovalService` in `services/core/approvals/`, exposing `create`, `findLive`, `list`, `revoke`, `revokeAll`, and `purgeExpired`. Two behaviors are load-bearing:

- **Expiry is evaluated on read**, inside `findLive`, not only by the sweep. This is the fourth token property `approval-service.ts:26-27` already commits to, for the same reason: a stale row must never be honored just because no cleanup has run.
- **At most one live grant per (agentPath, capabilityId).** `create` revokes any existing live row for the pair before inserting, so re-granting extends rather than accumulating, and the list a user reads never has duplicates in it.

Expiry is **absolute from the moment of the grant and never slides on use**. A sliding window would hand the agent control of its own expiry: the agent that acts most often would be the one that never has to ask again. That inverts the property this feature exists to preserve.

**An action already running is not interrupted when the window closes.** The gate is evaluated once, synchronously, before the handler is invoked, so a grant that expires mid-action has no effect on that action: it decided the question before the work started. Expiry stops the next call, not the one in flight. Nothing needs building for this; it is a property of where the check sits, and it is stated here so nobody later adds cancellation machinery for a case that does not exist.

### 3.3 One lookup, threaded through the tier gate

The grant check goes inside `enforceCapabilityTier` (`apps/server/src/services/core/capabilities/tier-enforcement.ts:479`), positioned deliberately:

1. `observe` returns allowed, unchanged (`:491`).
2. The `tierCeiling` check runs, unchanged (`:493-498` and the refusal it builds). **The grant check goes after it, so a grant can never lift a ceiling.** A ceiling refusal is already `approvable: false`, meaning no human decision can unlock it; a standing permission must not be able to either. (Honest note: nothing sets a ceiling below `destructive` today, so this invariant is structural, not currently active. See §What this does not cover.)
3. **New:** resolve a live grant, when and only when all three hold: the caller presented an identity, `approvals.standingGrants` is on, and `findLive(identity.agentPath, capability.id)` returns a row.
4. `act` returns allowed as before (`:518`), but now carries the resolved grant on the decision.
5. `destructive` with a live grant returns allowed, audited as auto-approved.
6. `destructive` with no grant takes the existing approval path, completely unchanged.

The grant is resolved **before** the `act` early-return rather than after, because `marketplace.install` and `marketplace.create_package` are tier `act` and still make the user wait at the marketplace's own confirmation step. Threading the grant onto the invocation context is what lets that second mechanism honor the same setting (§3.4).

**Every surface inherits this, by construction.** Because the gate moved inside `registry.invoke` (`registry.ts:387`), putting the lookup here reaches every registry-borne surface at once. No adapter needs touching and no list of surfaces needs maintaining.

**The one path that does NOT reach the lookup, stated so it is not a surprise.** A `TrustedCaller` short-circuits `authorizeCapability` (`tier-enforcement.ts:717`) and returns allowed at `tier-enforcement.ts:749`, before `enforceCapabilityTier` is called at `:751`. So a trusted caller never consults a grant, which is correct: it is the person clicking in their own cockpit, and it has already cleared a bar at least as high as the one a grant represents. It also means standing permissions can never widen what a trusted caller may do, because that path does not read them. Which modules may mint a marker is pinned by a source scan (`services/core/capabilities/__tests__/gate-bypass-scan.test.ts`), so this exemption cannot quietly spread.

**Only an identified agent can be trusted.** Grants key on `agentPath`, so a caller that presents no identity can never match one. Dropping a credential can only ever get a caller the gate, never past it. This is the mirror of the reasoning that made the ceiling universal (`tier-enforcement.ts:64-79`): there, shedding a credential must not widen reach; here, it cannot buy trust either.

`GrantedApproval` (`tier-enforcement.ts:224`) becomes a discriminated union so downstream can tell the two apart:

```ts
export type GrantedApproval =
  { via: 'approval'; approvalId: string } | { via: 'standing-grant'; grantId: string };
```

Its two consumers both survive the change, but neither is quite "unaffected", so state each:

- `callerContext` (`marketplace-capabilities.ts:83-95`) already tests **two** proofs, not one: `context.approval || context.trusted` (`:93`). It tests for presence, not shape, so the union passes through it unchanged. The `context.trusted` arm is a different proof of the same fact and has nothing to do with grants, so editing the `context.approval` arm must not disturb it.

  **Care is not a guarantee, so this gets an assertion.** Saying "be careful" here would be the exact pattern §3.8 exists to eliminate: an invariant that holds because nobody has broken it yet. A test pins `context.trusted` yielding `preApproved: true`, and it must land **before** the union change so that it is red if the change breaks the arm. A test written after the change it protects has never been red and proves nothing. See Testing Strategy and phase 2.

- The attribution observer's metadata (`apps/server/src/services/core/agent-identity/capability-attribution.ts:72-76`) reads `approvalId` directly, so it is updated to record which of the two allowed the call.

### 3.4 The marketplace confirmation step honors the same grant

`callerContext` (`marketplace-capabilities.ts:83-95`) already turns a spent approval into `preApproved: true`, which is what stops the handler asking a second time for something a person just allowed. Because §3.3 now sets `context.approval` for a standing grant on `act` capabilities too, install and package creation inherit the same behavior with no new mechanism: one lookup, one context field, two enforcement points.

This is what makes the setting honest. Without it, turning off approvals for an agent would stop the uninstall card and leave the install card, which is the same "don't ask did not mean don't ask" failure this spec exists to remove, one level down.

### 3.5 Creating a grant, and who is allowed to

Grant creation clears **two** bars, and it needs both.

1. The **same authority check as deciding an approval**, `resolveDecisionAuthority` (`apps/server/src/services/core/approvals/decision-authority.ts:146`). That resolver refuses any caller presenting an agent identity (`:152-159`) and any caller holding an approval token (`:163-170`), in every posture. So an honest agent cannot make its own request standing, and neither can anything holding the retry token.
2. A **session cookie**, per §3.0. Bar 1 alone is not enough: under `local-trust` it is satisfied by simply omitting two headers, which is the whole of FM1. Bar 2 is what makes bar 1 mean something, and it is why standing permissions require login.

Both are checked server-side on every grant-creating call. Neither is inferred from the other.

**Routes**, all on the existing `/api/approvals` router (`apps/server/src/index.ts:1290`):

- `POST /api/approvals/:id/grant` gains an optional body field `standing: boolean`. With `standing: true` it grants the approval as it does today **and** creates the standing grant. Refused with a clear code when login is off (`standing_grants_require_login`), when the caller has no session cookie, when `approvals.standingGrants` is off, or when the approval has no recorded agent path. A refusal of the standing part **does not** silently fall back to a plain grant: the caller asked for two things and gets told which one failed, because a fallback here would mean a user believing they had created a permission that does not exist.
- `GET /api/approvals/grants` lists live grants.
- `DELETE /api/approvals/grants/:id` revokes one.

**One schema addition is required.** The approvals table stores only a display _label_ for who asked (`approval-service.ts:293`, built at `tier-enforcement.ts:393-396` from `displayName || agentPath`), which is not a stable key. A nullable `requestedByPath` column is added, written from `identity.agentPath` when the gate records a request. It is used only to key the grant and is never rendered on the card, which continues to show the label.

### 3.6 Auditing

Extending the existing machinery, not building beside it.

- **Grant created** and **grant revoked** write Activity events (`approval.grant_created`, `approval.grant_revoked`) through the same path the existing decision audit uses (`apps/server/src/routes/approvals.ts:134-152`), carrying the posture the decision was made under, the agent path, the capability, and the expiry.
- **Every auto-approved invocation** is recorded by the gate's existing audit observer, `createCapabilityGateAuditObserver` (`apps/server/src/services/core/agent-identity/capability-gate-audit.ts:36-69`). Its `TierEnforcementAttempt` contract (`tier-enforcement.ts:240-252`) currently admits only `approval_required` and `denied`; it gains an auto-allowed case writing `capability.auto_approved` with `{ capabilityId, tier, grantId }`. The summary reads as a sentence, in the shape that module already uses: `"<agent> ran <action> under a standing permission you granted"`.
- **No approvals-table row is written per auto-approved call.** This respects a decision the codebase already made and documented: `AutoApproveConfirmationProvider`'s docstring says auto-approval "short-circuits the primitive rather than auto-granting through it: writing a row per call would flood the cockpit and the Activity feed" (`apps/server/src/services/marketplace-mcp/confirmation-provider.ts:157-160`). The durable record is the grant row plus one Activity event per use. The Activity feed is the surface built for volume and it is where the guide already sends people (`docs/guides/action-approvals.mdx:121-123`).

  **Say the retention plainly, because it bounds the audit trail:** Activity is pruned to 30 days by default (`apps/server/src/services/activity/activity-service.ts:142`). So the record of _which actions ran_ under a standing permission is a 30-day window, not a permanent ledger. The grant row itself, including who created it and when, is not pruned by that job. Anyone who needs a longer record of individual actions needs to export it, and the docs should not imply otherwise.

- **No pending-approval broadcast**, because there is no card to show. A new `approval_grant_changed` event on the global stream keeps open cockpits in sync. It must be added to `GENERIC_EVENTS` (`apps/client/src/layers/shared/lib/transport/stream-manager.ts:145-162`) or the client will never dispatch it.

### 3.7 What the user sees

**The approval card** (`apps/client/src/layers/features/approvals/ui/ApprovalCard.tsx:104-120`) gains a third button below the existing two. It appears only when standing grants are switched on and the approval carries an agent path, so an anonymous request never offers it.

Its label names the whole scope, so nobody learns what they granted afterwards: **"Allow, and stop asking about this for 8 hours"** (the number comes from the setting). One line under it names the exact pair in plain words: which agent, which action. Styled below "Allow" and less prominently, so the plain one-time answer stays the obvious default. "Don't allow" stays first and unstyled, keeping the property the guide calls out, that neither answer is dressed up as the safe one (`docs/guides/action-approvals.mdx:51`).

**Finding it again.** A grant a user cannot find is a dark pattern, so it is visible in two places without being nagged about:

- The header indicator (`apps/client/src/AppShell.tsx:462`) is hidden today when nothing is pending. It stays quiet, but when standing permissions are live it shows a low-key marker with the count. Opening it shows a **Standing permissions** section under any pending cards: agent, action, time left, and a **Stop trusting** button on each.
- Settings, under Security (`apps/client/src/layers/features/auth/ui/SecurityPanel.tsx:65-96`), holds the master switch, the window picker, and the same list. This is where the approvals guide already points people (`docs/guides/action-approvals.mdx:101`).

Turning the master switch off revokes every live grant, and the confirmation says so in those words rather than leaving stale rows behind.

**Making the two settings legible together.** The product owner's intent was that a user never discovers by surprise that "don't ask" did not mean don't ask. There is no per-agent permission mode to sit beside, so this is done at each of the three places a permission mode is actually chosen. When a bypass-style mode is selected, one line appears:

> This covers tools inside the session. Actions on DorkOS itself, like removing packages, still ask. Change that in Settings, under Security.

The three sites are the session picker (`apps/client/src/layers/features/status/ui/PermissionModeItem.tsx`), the channel binding (`apps/client/src/layers/entities/binding/ui/BindingAdvancedSection.tsx:162-171`), and the scheduled task form (`apps/client/src/layers/features/tasks/ui/TaskFormInner.tsx:282-291`). The condition has a single source of truth already, `isBypassPermissionMode` (`apps/client/src/layers/entities/session/lib/permission-mode.ts:19-21`), so the three cannot drift apart.

### 3.8 Permission mode is firewalled from the gate, and it is tested

`bypassPermissions` must not reach the tier gate. Today it does not, but only because nothing passes it: `TierEnforcementRequest` (`tier-enforcement.ts:254-271`) has no such field. **An absence is exactly the defect shape this spec is supposed to avoid**, so two guards replace it:

- **Behavioral, and primary.** A matrix over all six values of `PermissionModeSchema` (`packages/shared/src/schemas.ts:28`) asserting that a destructive capability with no live grant returns `approval_required` in every one of them, including `bypassPermissions`. This asserts the invariant a user cares about, and it keeps holding if the plumbing is refactored.
- **Structural.** A source-level guard asserting that no file under `services/core/capabilities/` or `services/core/approvals/` mentions `permissionMode`. That grep returns zero today; freezing it as a test is what stops someone wiring it in later.

The reason this matters is stronger than the one it was raised for. `operator.update_agent` does not expose `permissionMode` (verified against its input schema at `apps/server/src/services/core/operator/operator-capabilities.ts:189-207`), but that is not the only door. **An agent can already set `bypassPermissions` on a scheduled task** through the `tasks_update` MCP tool (`apps/server/src/services/core/external-mcp/task-tools.ts:83`, and at creation `:62`), and the tasks tools are not registry capabilities, so they carry no tier and pass through no gate. If the gate ever honored permission mode, that would be an ungated path for an agent to switch off its own destructive gate.

### 3.9 Retiring `MARKETPLACE_AUTO_APPROVE`

Removed, not deprecated.

- Delete the declaration (`apps/server/src/env.ts:44`) and its comment (`:42-43`).
- Delete the branch at `apps/server/src/index.ts:1591-1594`; the provider is always `TokenConfirmationProvider`.
- Delete `AutoApproveConfirmationProvider` (`apps/server/src/services/marketplace-mcp/confirmation-provider.ts:162-176`) and the stale references to the variable in comments (`confirmation-provider.ts:9`, `:154`; `tool-create-package.ts:13`, `:120`).
- Update its one prose mention, `contributing/external-agent-marketplace-access.md:84`.

**The deletion premise holds, but the inventory is bigger than one line.** The docstring's claim that CI uses it does not: there are zero hits for the name anywhere under `.github/`, `.env.example`, or `contributing/environment-variables.md`. But a whole-repo grep finds **eight hits across six files in `packages/evals`**, not the single setter an earlier draft claimed, and every one of them has to move or the deletion does not compile:

| Location                                                                                 | What it is                                                                                                   |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/evals/src/suite/operate.ts:481`, `:495`, `:508`                                | the case's comment, the `serverEnv` setter, and the tracked-gap note                                         |
| `packages/evals/src/types.ts:437`                                                        | the `serverEnv` field's own documentation                                                                    |
| `packages/evals/src/suite/governance.ts:716`                                             | a comment contrasting governance cases with the auto-approving one                                           |
| `packages/evals/src/suite/__tests__/operate.test.ts:94`                                  | **asserts `serverEnv` equals `{ MARKETPLACE_AUTO_APPROVE: '1' }`**, so it fails the moment the case migrates |
| `packages/evals/src/__tests__/governance-approval-cases.test.ts:159`                     | asserts the inverse for governance cases                                                                     |
| `packages/evals/src/runner/isolation/__tests__/child-process-launcher.test.ts:92`, `:99` | uses the name as a convenient sample env var                                                                 |

The last one is incidental (any string would do) and just needs a different sample. The rest are real consumers.

That is why the drift guard's scope and this inventory have to agree: a guard asserting the string is gone from `apps/server/src` **and** `packages/` only passes if all eight move, so the guard is written **after** the migration, not alongside it. The historical mentions under `specs/` are deliberately out of scope: they are a record of what was true when they were written and must not be rewritten.

`marketplaceInstallCase` moves onto the mechanism the governance suite already uses. `approvalPolicy` drives real approvals through the real API, with a granting case at `packages/evals/src/suite/governance.ts:831` and a denying one at `:760`. So the case drops `serverEnv` and answers its own approval instead, which exercises production code rather than a test-only branch. This is a better test, and it closes the tracked gap the eval itself records at `operate.ts:502-511`. `operate.test.ts:94` is rewritten to assert the case carries an `approvalPolicy` rather than an env var.

**One thing must be verified during execution rather than assumed:** that an install's confirmation, which comes from the marketplace provider rather than the tier gate, surfaces through the same approvals API the policy answers. If it does not, the fallback is to seed a standing grant in the eval server's config, which tests the new path directly and is equally honest.

## User Experience

Nothing changes until the operator asks for it: the switch is off by default and the card looks exactly as it does today.

Once turned on, the fifth time an agent asks the same question the operator answers it permanently instead, from the card, in one click, and sees exactly what they granted written on the button. For the rest of the working day that agent does that one thing without interrupting them, and every time it does, the activity feed says so. When they want it back, the header shows the permission is live and one click ends it.

## Testing Strategy

**Unit.** Grant lifecycle: create, supersede on re-grant, expiry evaluated on read, revoke, `revokeAll` on master-switch-off, sweep. Gate matrix: for each tier, the cross product of {no identity, identity with grant, identity without grant} times {switch on, switch off}, asserting that an anonymous caller never matches a grant and that a ceiling refusal always beats a grant. Authority: grant creation refused for a caller presenting an agent identity, and for one holding an approval token.

**The FM1 chain, reproduced as a test rather than described.** This is the most important test in the spec, because the hole it covers was found by running it, not by reading. Drive the exact four steps from §3.0 against a live app with login off, and assert each is now refused: an anonymous `PATCH /api/config` touching `approvals.*` is refused; an anonymous header-free `POST /api/approvals/:id/grant {"standing":true}` is refused; and with login on, the same grant call carrying a valid **API key** rather than a cookie is refused too. A test that only asserts "a cookie works" would pass against the broken design.

Also assert the negative that keeps the feature usable: with login on and a cookie, the whole flow succeeds; and turning login off revokes live grants rather than leaving them dormant.

**The two firewall guards in §3.8**, which are the tests that keep the settled decisions true rather than merely currently true.

**The `context.trusted` arm, pinned before it is touched.** `callerContext` must yield `preApproved: true` for a trusted caller. Assert it directly, and **land the assertion before the `GrantedApproval` union change**, so it is capable of going red on the change it exists to protect. Written afterwards it would only ever have been green, which is not evidence of anything.

Note for whoever implements it: this arm may currently be **unreachable in production**. Markers are minted at only two routes, and those routes call the marketplace flows directly rather than through `registry.invoke`, which is what populates a handler context. That is reasoned, not traced, so treat it as a lead rather than a fact, and do not use it as a reason to skip the test. A dead arm is still worth preserving (the trusted path is how the cockpit avoids asking a person twice) and an unreachable arm is exactly the kind that rots silently. If implementation confirms it is unreachable, say so in the PR rather than deleting the arm on a hunch.

**Integration.** A destructive call with a live grant proceeds with no card and produces exactly one Activity record. An `act` call covered by a grant clears the marketplace confirmation step too, which is the §3.4 claim and the one most likely to be quietly wrong. Turning the master switch off mid-flight makes the very next call ask again.

**Drift guards.** The two config classification tables (which already fail on an unclassified leaf), plus the `MARKETPLACE_AUTO_APPROVE` absence guard.

**Evals.** `marketplaceInstallCase` migrated per §3.9. The three existing governance cases must stay green unchanged, since they set no grant and prove the gate still stops an ungranted destructive call.

**Config.** A stale-config upgrade-path test, not only a fresh-install one.

## Performance Considerations

One indexed lookup on `(agentPath, capabilityId)` per gated invocation, and only when an identity is present and the switch is on. Expired grants are removed by the sweep that already runs for approvals. The Activity feed gains one row per auto-approved action, which is the same order of volume as the approval it replaces and is already pruned.

## Security Considerations

The design's safety properties are consequences of structure rather than rules anyone has to follow: an unidentified caller cannot match a grant because grants key on agent path; a grant cannot lift a ceiling because the lookup sits after the ceiling check; a trusted caller never reads a grant because it short-circuits before the gate; and the agent that asked cannot create the grant because creation runs through `resolveDecisionAuthority` **and** requires a session cookie.

The cookie requirement is the one that took a revision to get right, so state what it is doing. `resolveDecisionAuthority` alone refuses an agent that names itself, which is the honest-agent case and the common one. It does not refuse an agent that simply omits its headers, and under `local-trust` nothing can. Requiring a cookie is not an extra layer on a sound check; it is the check, and the earlier design shipped without it. That is why standing permissions require login rather than degrading gracefully without it: a gracefully degrading version of this feature is one that cannot tell who is asking.

Beyond those: the setting is operator-only with a build-failing drift guard, so no capability can write it. Grants are bounded by a schema that cannot express "forever". The window does not slide, so an agent cannot extend its own trust. Turning the feature off revokes everything rather than leaving dormant rows that would wake up later.

## What this does not cover

Stated plainly, in the manner of `docs/guides/action-approvals.mdx:91-108`.

1. **With login off, standing permissions do not exist at all.** That is the §3.0 resolution, and it is the honest one: in that posture DorkOS cannot tell the person in the cockpit from anything else running as the same user (`decision-authority.ts:34-58`), so it cannot evaluate "trust this agent". The control is visible and disabled, not silently absent.
2. **With login on, this still does not stop code that already runs as you.** Requiring a cookie stops a header-stripping HTTP caller, which is the specific hole §3.0 closes. It does not stop something with filesystem access from editing `~/.dork/config.json` or writing a grant row into the database directly. Nothing on the same machine can stop that, and this spec does not claim to.
3. **The general `trustedCaller` divergence is untouched.** `routes/config.ts:231` still lets a header-stripping caller skip the operator-only check for every path that is not `approvals.*`, including `auth.enabled`, `tunnel.*`, and `mcp.*`. This spec narrows the hole for its own setting; it does not close it. That work is DOR-505. **(DOR-505 has since closed the login-on half for every operator-only path and left the login-off half open, deliberately; see the resolution note in §3.1.)**
4. **A standing permission really does reduce safety.** That is the point of it. It is a deliberate trade, bounded by one agent, one action, and a clock.
5. **It does nothing about tools inside a session.** Writing files and running commands are governed by permission mode, which this spec deliberately keeps separate.
6. **Most agent tools are not gated at all, so this cannot loosen or tighten them.** Scheduled tasks, agent-to-agent messages, agent discovery, and extensions still do not ask, exactly as the guide already warns (`docs/guides/action-approvals.mdx:65-71`).
7. **Some paths sit outside the registry entirely.** `create_agent` and `mesh_register` write agent manifests through MCP tools that are not capabilities, so they carry no tier and pass through no gate. None of these is changed here. (The cockpit's own marketplace routes used to belong on this list and no longer do: DOR-467 routed them through `authorizeCapability` with a trusted-caller marker, install at `apps/server/src/routes/marketplace.ts:586-591` and uninstall at `:638-642`, and the route comment at `:629-632` names this "the door DOR-467 closed.")
8. **Agent identity is a name, not a fence.** A grant follows an agent path, so anything able to write that agent's manifest or take its token inherits the trust. An agent can also create a _new_ agent, but a new agent has no grants, so that gains it nothing.
9. **`tierCeiling` is not currently protecting anyone.** The column exists and is read (`packages/db/src/schema/agent-identity.ts:50`), but the only production caller of `mint()` passes just the path and display name (`apps/server/src/services/core/agent-identity/agent-token-env.ts:52-55`), so every agent sits at the default `destructive`. The grant-cannot-lift-a-ceiling property is real in the code and inert in practice until something sets a lower ceiling.
10. **Revoking does not undo.** Ending a permission stops the next action; it does not reverse what already ran.

## Documentation

`docs/guides/action-approvals.mdx` gains a section on standing permissions: what the third button grants, for how long, where to find and end it, and an honest note that it lowers the gate on purpose. Its existing limits callout gains the direct-filesystem point from item 2 above, and the guide must say plainly that standing permissions need Require login, in the same place it already explains what Require login buys. `docs/guides/tool-approval.mdx` gains the matching one-line clarifier next to the permission-mode list. `contributing/configuration.md` and `docs/getting-started/configuration.mdx` gain the two new settings. A changelog fragment per PR.

## Implementation Phases

0. **The cookie bar (§3.0)**: the `credential` field on `RequestUser` and its two assignments, the cookie requirement on grant creation and on `approvals.*` writes, `REQUIRES_COOKIE_CONFIG_PATHS` (renamed `REQUIRES_LOGIN_CONFIG_PATHS` by DOR-505; see the resolution note in §3.1) and its drift guard, and the FM1 chain reproduced as a test. **First, and on its own.** It is the smallest piece, it is the one a reviewer most needs to see in isolation, and everything after it is unsafe to merge without it.
1. **Config and store**: the two config leaves with both classifications and the migration, the `approval_grants` table, `ApprovalGrantService`, the `requestedByPath` column.
2. **Enforcement and audit**, in this order within the phase: **first** the assertion that a trusted caller yields `preApproved: true`, green against the code as it stands; **then** the `GrantedApproval` union, so that assertion is what catches a broken `context.trusted` arm. After those: the gate lookup, the marketplace context threading, the audit extension, the routes, and both firewall guards from §3.8.
3. **Surfaces**: the third card button, the login-off disabled state, the header indicator section, the Security panel, the three permission-mode clarifiers, the SSE event and its allowlist entry.
4. **Retirement**: migrate all eight `MARKETPLACE_AUTO_APPROVE` references, delete the variable, then add the absence guard, and update the docs.

Phase 4 depends on phase 2, because the eval migration needs the replacement path to exist. Within phase 4 the guard is written last, after the eight references have moved, or it fails on the commit that adds it.

## Open Questions

- ~~Where does per-agent trust live?~~ **(RESOLVED)** Policy in `~/.dork/config.json` classified operator-only; grants in a new SQLite table. Rationale: `agent.json` is file-canonical with a reconciler that would propagate an agent's own edit and no integrity check to stop it, and the repo already resolved that approval-shaped state belongs in SQLite rather than user-owned files.
- ~~How is the grant threaded into the marketplace confirmation provider, which is built at boot?~~ **(RESOLVED)** It is not threaded into the provider. The gate resolves the grant before the `act` early-return and puts it on the invocation context, where `callerContext` already converts a granted approval into `preApproved`. No change to the boot-time provider construction.
- ~~Is the grants roster exposed to agents through `config_get`?~~ **(RESOLVED)** Not applicable, and that is the point: grants live in SQLite, so no roster exists in config to expose. The two config leaves are `expose` because they describe a posture, not who is trusted.
- ~~Where is the setting surfaced, given permission mode has no per-agent home?~~ **(RESOLVED)** Canonical home is Settings under Security, with the live list mirrored on the header indicator, plus a one-line clarifier at each of the three places a permission mode is actually chosen.
- ~~Is `operator-only` classification enough to stop an agent granting itself trust?~~ **(RESOLVED)** No. It is enforced unconditionally only on the capability surface; on `PATCH /api/config` it sits behind `trustedCaller`, which a header-stripping agent clears under `local-trust`. Grant creation and `approvals.*` writes therefore require a session cookie, and standing permissions require login. Reproduced and specified in §3.0.
- ~~Should the feature degrade to something weaker when login is off, rather than being unavailable?~~ **(RESOLVED)** No. Any weaker check is one the agent can satisfy as easily as the operator, so it would assert a distinction that does not exist. Visible-but-disabled with a plain reason, and a path to enable login.

## Related ADRs

Candidates this spec surfaces, not yet written: standing permissions are per agent per capability with no wildcard; trust is absolute-expiring and never slides on use; permission mode is firewalled from the tier gate by tested invariant rather than by a field staying absent; and a capability-surface classification is not by itself an authorization boundary when an HTTP route can reach the same write behind a weaker check. These should be extracted with `/adr:from-spec` after review, per the significance rubric.

## References

- `specs/agent-approval-settings/01-ideation.md`: the options weighed and the verification behind every claim here.
- `specs/agent-trust/02-specification.md`: the tier gate, the approval primitive, and the SQLite-not-files resolution this spec follows.
- `.claude/rules/agent-storage.md` and `decisions/0043-file-canonical-source-of-truth-for-mesh-registry.md`: why `agent.json` is not an option.
- `.claude/skills/adding-config-fields/SKILL.md`: the config change lifecycle followed in §3.1.
- `docs/guides/action-approvals.mdx`: the user-facing gate and the honest-limits section extended here.
