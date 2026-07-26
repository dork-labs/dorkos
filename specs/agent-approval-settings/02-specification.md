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

Give the operator an explicit, findable way to let a named agent do a named thing without being asked every time, bounded by a clock, revocable in one click, and recorded either way. The setting is its own control, not a side effect of the runtime permission mode. It is operator-only, so an agent cannot grant itself trust. It replaces the undocumented `MARKETPLACE_AUTO_APPROVE` environment variable, which is deleted.

## Background / Problem Statement

DorkOS gates destructive capabilities behind a human approval, and the gate is enforced server-side at two choke points (`apps/server/src/routes/capabilities-invoke.ts:93` and `apps/server/src/services/core/capabilities/mcp-projection.ts:196`). There is no supported way to turn it off. The only bypass in the tree, `MARKETPLACE_AUTO_APPROVE` (`apps/server/src/env.ts:44`, read once at `apps/server/src/index.ts:1588`), is scoped to tests by its own docstring, absent from `.env.example` and the docs, and does not touch the tier gate at all.

The full argument, the options weighed, and the verification behind each claim are in `01-ideation.md`. Three facts from it drive this design:

1. **Exactly one capability in the server is `destructive`**: `marketplace.uninstall` (`apps/server/src/services/marketplace-mcp/marketplace-capabilities.ts:234`). `marketplace.install` (`:212`) and `marketplace.create_package` (`:261`) are tier `act`, so the tier gate never gates them. What stops those is the marketplace's own older confirmation step. **Two mechanisms make a user wait, so one setting has to satisfy both** or "stop asking" will silently keep asking.
2. **Per-agent trust cannot live in `agent.json`.** The manifest on disk is canonical and the reconciler syncs file to DB every five minutes (`packages/mesh/src/reconciler.ts:114-135`, direction stated at `:197`; cadence `packages/mesh/src/mesh-core.ts:391`, wired at `apps/server/src/index.ts:804`). There is no checksum, signature, or integrity check on the manifest anywhere. An agent that can write a file would trust itself within five minutes.
3. **There is no per-agent permission mode.** It is a property of a session (`packages/db/src/schema/sessions.ts:22`), a channel binding, and a scheduled task (`packages/db/src/schema/tasks.ts:16`). This changes where the two settings can be shown together; see §3.7.

## Goals

- An operator can say "stop asking about this agent doing this thing" and have it hold, for a bounded time.
- The setting is explicit and separate from runtime permission mode, and the two are never confused for each other in the UI.
- No agent can turn the gate off for itself, through any capability, tool, or route.
- Every action that proceeds without a card is still recorded, in the place users already look.
- Every standing permission is findable and revocable from one place, without hunting.
- `MARKETPLACE_AUTO_APPROVE` is gone, with its one real consumer migrated onto production code paths.

## Non-Goals

- Wiring `bypassPermissions` or any other permission mode into the tier gate. This is forbidden by design; §3.8 makes it a tested invariant rather than an absence.
- Bringing new surfaces under the gate. Scheduled tasks, relay, mesh, and extensions stay ungated, exactly as `docs/guides/action-approvals.mdx:65-71` already tells users.
- Setting `tierCeiling` below `destructive`. The column exists and is read, but nothing writes a lower value today; that stays true after this change.
- Remote or mobile approval delivery.
- Any "trust this agent for everything" control. The schema deliberately has no wildcard.

## Technical Dependencies

Internal only: the capability tier gate and approval primitive from spec `agent-trust`; `ApprovalService` and `resolveDecisionAuthority` (`apps/server/src/services/core/approvals/`); the `conf`-backed user config and its two classification tables (`config-disclosure.ts`, `config-write-policy.ts`); the Activity feed and its two observers; the global SSE fan-out; the marketplace `ConfirmationProvider` seam; `packages/evals` and its `approvalPolicy` mechanism.

## Detailed Design

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

Keyed on `agentPath`, not on an identity token. Tokens are minted fresh on every spawn (`apps/server/src/services/core/agent-identity/agent-token-env.ts:52-55`), so a token-keyed grant would evaporate the next time the agent started. `agentPath` is the durable identifier, and the identity table already treats it that way (`packages/db/src/schema/agent-identity.ts:40`).

`ApprovalGrantService`, alongside `ApprovalService` in `services/core/approvals/`, exposing `create`, `findLive`, `list`, `revoke`, `revokeAll`, and `purgeExpired`. Two behaviors are load-bearing:

- **Expiry is evaluated on read**, inside `findLive`, not only by the sweep. This is the fourth token property `approval-service.ts:26-27` already commits to, for the same reason: a stale row must never be honored just because no cleanup has run.
- **At most one live grant per (agentPath, capabilityId).** `create` revokes any existing live row for the pair before inserting, so re-granting extends rather than accumulating, and the list a user reads never has duplicates in it.

Expiry is **absolute from the moment of the grant and never slides on use**. A sliding window would hand the agent control of its own expiry: the agent that acts most often would be the one that never has to ask again. That inverts the property this feature exists to preserve.

### 3.3 One lookup, threaded through the tier gate

The grant check goes inside `enforceCapabilityTier` (`apps/server/src/services/core/capabilities/tier-enforcement.ts:461`), positioned deliberately:

1. `observe` returns allowed, unchanged (`:473`).
2. The `tierCeiling` check runs, unchanged (`:478-496`). **The grant check goes after it, so a grant can never lift a ceiling.** A ceiling refusal is already `approvable: false`, meaning no human decision can unlock it; a standing permission must not be able to either. (Honest note: nothing sets a ceiling below `destructive` today, so this invariant is structural, not currently active. See §What this does not cover.)
3. **New:** resolve a live grant, when and only when all three hold: the caller presented an identity, `approvals.standingGrants` is on, and `findLive(identity.agentPath, capability.id)` returns a row.
4. `act` returns allowed as before, but now carries the resolved grant on the decision.
5. `destructive` with a live grant returns allowed, audited as auto-approved.
6. `destructive` with no grant takes the existing approval path, completely unchanged.

The grant is resolved **before** the `act` early-return rather than after, because `marketplace.install` and `marketplace.create_package` are tier `act` and still make the user wait at the marketplace's own confirmation step. Threading the grant onto the invocation context is what lets that second mechanism honor the same setting (§3.4).

**Only an identified agent can be trusted.** Grants key on `agentPath`, so a caller that presents no identity can never match one. Dropping a credential can only ever get a caller the gate, never past it. This is the mirror of the reasoning that made the ceiling universal (`tier-enforcement.ts:51-66`): there, shedding a credential must not widen reach; here, it cannot buy trust either.

`GrantedApproval` (`tier-enforcement.ts:207-210`) becomes a discriminated union so downstream can tell the two apart:

```ts
export type GrantedApproval =
  | { via: 'approval'; approvalId: string }
  | { via: 'standing-grant'; grantId: string };
```

Its only consumers are `callerContext` (`marketplace-capabilities.ts:83-89`), which tests for presence and is unaffected, and the attribution observer's metadata (`apps/server/src/services/core/agent-identity/capability-attribution.ts:72-76`), which is updated to record which of the two allowed the call.

### 3.4 The marketplace confirmation step honors the same grant

`callerContext` (`marketplace-capabilities.ts:83-89`) already turns a spent approval into `preApproved: true`, which is what stops the handler asking a second time for something a person just allowed. Because §3.3 now sets `context.approval` for a standing grant on `act` capabilities too, install and package creation inherit the same behavior with no new mechanism: one lookup, one context field, two enforcement points.

This is what makes the setting honest. Without it, turning off approvals for an agent would stop the uninstall card and leave the install card, which is the same "don't ask did not mean don't ask" failure this spec exists to remove, one level down.

### 3.5 Creating a grant, and who is allowed to

Grant creation travels the **same authority check as deciding an approval**, `resolveDecisionAuthority` (`apps/server/src/services/core/approvals/decision-authority.ts:146`). That resolver refuses any caller presenting an agent identity (`:152-159`) and any caller holding an approval token (`:163-170`), in every posture. So the agent that asked cannot make its own request standing, and neither can anything holding the retry token.

**Routes**, all on the existing `/api/approvals` router (`apps/server/src/index.ts:1290`):

- `POST /api/approvals/:id/grant` gains an optional body field `standing: boolean`. With `standing: true` it grants the approval as it does today **and** creates the standing grant. Refused with a clear code when `approvals.standingGrants` is off, or when the approval has no recorded agent path.
- `GET /api/approvals/grants` lists live grants.
- `DELETE /api/approvals/grants/:id` revokes one.

**One schema addition is required.** The approvals table stores only a display _label_ for who asked (`approval-service.ts:293`, built at `tier-enforcement.ts:376-379` from `displayName || agentPath`), which is not a stable key. A nullable `requestedByPath` column is added, written from `identity.agentPath` when the gate records a request. It is used only to key the grant and is never rendered on the card, which continues to show the label.

### 3.6 Auditing

Extending the existing machinery, not building beside it.

- **Grant created** and **grant revoked** write Activity events (`approval.grant_created`, `approval.grant_revoked`) through the same path the existing decision audit uses (`apps/server/src/routes/approvals.ts:142-160`), carrying the posture the decision was made under, the agent path, the capability, and the expiry.
- **Every auto-approved invocation** is recorded by the gate's existing audit observer, `createCapabilityGateAuditObserver` (`apps/server/src/services/core/agent-identity/capability-gate-audit.ts:36-69`). Its `TierEnforcementAttempt` contract (`tier-enforcement.ts:224-235`) currently admits only `approval_required` and `denied`; it gains an auto-allowed case writing `capability.auto_approved` with `{ capabilityId, tier, grantId }`. The summary reads as a sentence, in the shape that module already uses: `"<agent> ran <action> under a standing permission you granted"`.
- **No approvals-table row is written per auto-approved call.** This respects a decision the codebase already made and documented: `AutoApproveConfirmationProvider`'s docstring says auto-approval "short-circuits the primitive rather than auto-granting through it: writing a row per call would flood the cockpit and the Activity feed" (`apps/server/src/services/marketplace-mcp/confirmation-provider.ts:157-160`). The durable record is the grant row plus one Activity event per use. The Activity feed is the surface built for volume, it is pruned (`apps/server/src/services/activity/activity-service.ts:142-151`), and it is where the guide already sends people (`docs/guides/action-approvals.mdx:121-123`).
- **No pending-approval broadcast**, because there is no card to show. A new `approval_grant_changed` event on the global stream keeps open cockpits in sync. It must be added to `GENERIC_EVENTS` (`apps/client/src/layers/shared/lib/transport/stream-manager.ts:145-162`) or the client will never dispatch it.

### 3.7 What the user sees

**The approval card** (`apps/client/src/layers/features/approvals/ui/ApprovalCard.tsx:104-120`) gains a third button below the existing two. It appears only when standing grants are switched on and the approval carries an agent path, so an anonymous request never offers it.

Its label names the whole scope, so nobody learns what they granted afterwards: **"Allow, and stop asking about this for 8 hours"** (the number comes from the setting). One line under it names the exact pair in plain words: which agent, which action. Styled below "Allow" and less prominently, so the plain one-time answer stays the obvious default. "Don't allow" stays first and unstyled, keeping the property the guide calls out, that neither answer is dressed up as the safe one (`docs/guides/action-approvals.mdx:51`).

**Finding it again.** A grant a user cannot find is a dark pattern, so it is visible in two places without being nagged about:

- The header indicator (`apps/client/src/AppShell.tsx:462`) is hidden today when nothing is pending. It stays quiet, but when standing permissions are live it shows a low-key marker with the count. Opening it shows a **Standing permissions** section under any pending cards: agent, action, time left, and a **Stop trusting** button on each.
- Settings, under Security (`apps/client/src/layers/features/auth/ui/SecurityPanel.tsx:65-96`), holds the master switch, the window picker, and the same list. This is where the approvals guide already points people (`docs/guides/action-approvals.mdx:99`).

Turning the master switch off revokes every live grant, and the confirmation says so in those words rather than leaving stale rows behind.

**Making the two settings legible together.** The product owner's intent was that a user never discovers by surprise that "don't ask" did not mean don't ask. There is no per-agent permission mode to sit beside, so this is done at each of the three places a permission mode is actually chosen. When a bypass-style mode is selected, one line appears:

> This covers tools inside the session. Actions on DorkOS itself, like removing packages, still ask. Change that in Settings, under Security.

The three sites are the session picker (`apps/client/src/layers/features/status/ui/PermissionModeItem.tsx`), the channel binding (`apps/client/src/layers/entities/binding/ui/BindingAdvancedSection.tsx:162-171`), and the scheduled task form (`apps/client/src/layers/features/tasks/ui/TaskFormInner.tsx:282-291`). The condition has a single source of truth already, `isBypassPermissionMode` (`apps/client/src/layers/entities/session/lib/permission-mode.ts:19-21`), so the three cannot drift apart.

### 3.8 Permission mode is firewalled from the gate, and it is tested

`bypassPermissions` must not reach the tier gate. Today it does not, but only because nothing passes it: `TierEnforcementRequest` (`tier-enforcement.ts:238-254`) has no such field. **An absence is exactly the defect shape this spec is supposed to avoid**, so two guards replace it:

- **Behavioral, and primary.** A matrix over all six values of `PermissionModeSchema` (`packages/shared/src/schemas.ts:28`) asserting that a destructive capability with no live grant returns `approval_required` in every one of them, including `bypassPermissions`. This asserts the invariant a user cares about, and it keeps holding if the plumbing is refactored.
- **Structural.** A source-level guard asserting that no file under `services/core/capabilities/` or `services/core/approvals/` mentions `permissionMode`. That grep returns zero today; freezing it as a test is what stops someone wiring it in later.

The reason this matters is stronger than the one it was raised for. `operator.update_agent` does not expose `permissionMode` (verified against its input schema at `apps/server/src/services/core/operator/operator-capabilities.ts:189-207`), but that is not the only door. **An agent can already set `bypassPermissions` on a scheduled task** through the `tasks_update` MCP tool (`apps/server/src/services/core/external-mcp/task-tools.ts:83`, and at creation `:62`), and the tasks tools are not registry capabilities, so they carry no tier and pass through no gate. If the gate ever honored permission mode, that would be an ungated path for an agent to switch off its own destructive gate.

### 3.9 Retiring `MARKETPLACE_AUTO_APPROVE`

Removed, not deprecated.

- Delete the declaration (`apps/server/src/env.ts:44`) and its comment (`:42-43`).
- Delete the branch at `apps/server/src/index.ts:1587-1590`; the provider is always `TokenConfirmationProvider`.
- Delete `AutoApproveConfirmationProvider` (`apps/server/src/services/marketplace-mcp/confirmation-provider.ts:162-176`) and the stale references to the variable in comments (`confirmation-provider.ts:9`, `:154`; `tool-create-package.ts:13`, `:120`).
- Update its one prose mention, `contributing/external-agent-marketplace-access.md:84`.

**The migration cost is one eval case.** The docstring's claim that CI uses it does not hold: there are zero hits for the name anywhere under `.github/`. Its only setter in the repository is `packages/evals/src/suite/operate.ts:495`.

That case moves onto the mechanism the governance suite already uses. `approvalPolicy` drives real approvals through the real API, with a granting case at `packages/evals/src/suite/governance.ts:831` and a denying one at `:760`. So `marketplaceInstallCase` drops `serverEnv` and answers its own approval instead, which exercises production code rather than a test-only branch. This is a better test, and it closes the tracked gap the eval itself records at `operate.ts:502-509`.

**One thing must be verified during execution rather than assumed:** that an install's confirmation, which comes from the marketplace provider rather than the tier gate, surfaces through the same approvals API the policy answers. If it does not, the fallback is to seed a standing grant in the eval server's config, which tests the new path directly and is equally honest.

A drift guard asserts the string `MARKETPLACE_AUTO_APPROVE` no longer appears under `apps/server/src` or `packages/`, so it cannot quietly return.

## User Experience

Nothing changes until the operator asks for it: the switch is off by default and the card looks exactly as it does today.

Once turned on, the fifth time an agent asks the same question the operator answers it permanently instead, from the card, in one click, and sees exactly what they granted written on the button. For the rest of the working day that agent does that one thing without interrupting them, and every time it does, the activity feed says so. When they want it back, the header shows the permission is live and one click ends it.

## Testing Strategy

**Unit.** Grant lifecycle: create, supersede on re-grant, expiry evaluated on read, revoke, `revokeAll` on master-switch-off, sweep. Gate matrix: for each tier, the cross product of {no identity, identity with grant, identity without grant} times {switch on, switch off}, asserting that an anonymous caller never matches a grant and that a ceiling refusal always beats a grant. Authority: grant creation refused for a caller presenting an agent identity, and for one holding an approval token.

**The two firewall guards in §3.8**, which are the tests that keep the settled decisions true rather than merely currently true.

**Integration.** A destructive call with a live grant proceeds with no card and produces exactly one Activity record. An `act` call covered by a grant clears the marketplace confirmation step too, which is the §3.4 claim and the one most likely to be quietly wrong. Turning the master switch off mid-flight makes the very next call ask again.

**Drift guards.** The two config classification tables (which already fail on an unclassified leaf), plus the `MARKETPLACE_AUTO_APPROVE` absence guard.

**Evals.** `marketplaceInstallCase` migrated per §3.9. The three existing governance cases must stay green unchanged, since they set no grant and prove the gate still stops an ungranted destructive call.

**Config.** A stale-config upgrade-path test, not only a fresh-install one.

## Performance Considerations

One indexed lookup on `(agentPath, capabilityId)` per gated invocation, and only when an identity is present and the switch is on. Expired grants are removed by the sweep that already runs for approvals. The Activity feed gains one row per auto-approved action, which is the same order of volume as the approval it replaces and is already pruned.

## Security Considerations

The design's three safety properties are consequences of structure rather than rules anyone has to follow: an unidentified caller cannot match a grant because grants key on agent path; a grant cannot lift a ceiling because the lookup sits after the ceiling check; and the agent that asked cannot create the grant because creation runs through `resolveDecisionAuthority`.

Beyond those: the setting is operator-only with a build-failing drift guard, so no capability can write it. Grants are bounded by a schema that cannot express "forever". The window does not slide, so an agent cannot extend its own trust. Turning the feature off revokes everything rather than leaving dormant rows that would wake up later.

## What this does not cover

Stated plainly, in the manner of `docs/guides/action-approvals.mdx:91-108`.

1. **With login off, this stops agents, not programs.** `auth.enabled` defaults to `false`, and in that posture DorkOS cannot tell the person in the cockpit from anything else running as the same user (`decision-authority.ts:34-58`). Making the setting operator-only stops the _capability surface_; it does not stop something with shell access from editing `~/.dork/config.json` or the database directly. Turning on Require login is what closes that, and only for the deciding path.
2. **A standing permission really does reduce safety.** That is the point of it. It is a deliberate trade, bounded by one agent, one action, and a clock.
3. **It does nothing about tools inside a session.** Writing files and running commands are governed by permission mode, which this spec deliberately keeps separate.
4. **Most agent tools are not gated at all, so this cannot loosen or tighten them.** Scheduled tasks, agent-to-agent messages, agent discovery, and extensions still do not ask, exactly as the guide already warns (`docs/guides/action-approvals.mdx:65-71`).
5. **Some paths sit outside the registry entirely.** `create_agent` and `mesh_register` write agent manifests through MCP tools that are not capabilities, so they carry no tier and pass through no gate. The cockpit's own marketplace routes call the installer directly with neither mechanism (`apps/server/src/routes/marketplace.ts:490`, `:527`). None of these is changed here.
6. **Agent identity is a name, not a fence.** A grant follows an agent path, so anything able to write that agent's manifest or take its token inherits the trust. An agent can also create a _new_ agent, but a new agent has no grants, so that gains it nothing.
7. **`tierCeiling` is not currently protecting anyone.** The column exists and is read (`packages/db/src/schema/agent-identity.ts:50`), but the only production caller of `mint()` passes just the path and display name (`apps/server/src/services/core/agent-identity/agent-token-env.ts:52-55`), so every agent sits at the default `destructive`. The grant-cannot-lift-a-ceiling property is real in the code and inert in practice until something sets a lower ceiling.
8. **Revoking does not undo.** Ending a permission stops the next action; it does not reverse what already ran.

## Documentation

`docs/guides/action-approvals.mdx` gains a section on standing permissions: what the third button grants, for how long, where to find and end it, and an honest note that it lowers the gate on purpose. Its existing limits callout gains the direct-filesystem point from item 1 above. `docs/guides/tool-approval.mdx` gains the matching one-line clarifier next to the permission-mode list. `contributing/configuration.md` and `docs/getting-started/configuration.mdx` gain the two new settings. A changelog fragment per PR.

## Implementation Phases

1. **Config and store**: the two config leaves with both classifications and the migration, the `approval_grants` table, `ApprovalGrantService`, the `requestedByPath` column.
2. **Enforcement and audit**: the gate lookup, the `GrantedApproval` union, the marketplace context threading, the audit extension, the routes, and both firewall guards from §3.8.
3. **Surfaces**: the third card button, the header indicator section, the Security panel, the three permission-mode clarifiers, the SSE event and its allowlist entry.
4. **Retirement**: delete `MARKETPLACE_AUTO_APPROVE`, migrate the eval, add the absence guard, update the docs.

Phase 4 depends on phase 2, because the eval migration needs the replacement path to exist.

## Open Questions

- ~~Where does per-agent trust live?~~ **(RESOLVED)** Policy in `~/.dork/config.json` classified operator-only; grants in a new SQLite table. Rationale: `agent.json` is file-canonical with a reconciler that would propagate an agent's own edit and no integrity check to stop it, and the repo already resolved that approval-shaped state belongs in SQLite rather than user-owned files.
- ~~How is the grant threaded into the marketplace confirmation provider, which is built at boot?~~ **(RESOLVED)** It is not threaded into the provider. The gate resolves the grant before the `act` early-return and puts it on the invocation context, where `callerContext` already converts a granted approval into `preApproved`. No change to the boot-time provider construction.
- ~~Is the grants roster exposed to agents through `config_get`?~~ **(RESOLVED)** Not applicable, and that is the point: grants live in SQLite, so no roster exists in config to expose. The two config leaves are `expose` because they describe a posture, not who is trusted.
- ~~Where is the setting surfaced, given permission mode has no per-agent home?~~ **(RESOLVED)** Canonical home is Settings under Security, with the live list mirrored on the header indicator, plus a one-line clarifier at each of the three places a permission mode is actually chosen.

## Related ADRs

Candidates this spec surfaces, not yet written: standing permissions are per agent per capability with no wildcard; trust is absolute-expiring and never slides on use; permission mode is firewalled from the tier gate by tested invariant rather than by a field staying absent. These should be extracted with `/adr:from-spec` after review, per the significance rubric.

## References

- `specs/agent-approval-settings/01-ideation.md`: the options weighed and the verification behind every claim here.
- `specs/agent-trust/02-specification.md`: the tier gate, the approval primitive, and the SQLite-not-files resolution this spec follows.
- `.claude/rules/agent-storage.md` and `decisions/0043-file-canonical-source-of-truth-for-mesh-registry.md`: why `agent.json` is not an option.
- `.claude/skills/adding-config-fields/SKILL.md`: the config change lifecycle followed in §3.1.
- `docs/guides/action-approvals.mdx`: the user-facing gate and the honest-limits section extended here.
