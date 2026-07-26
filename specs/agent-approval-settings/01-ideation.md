---
slug: agent-approval-settings
id: 260726-015631
created: 2026-07-25
status: ideation
---

# Agent approval settings: a supported way to say "stop asking"

**Author:** Ceres (directed by Dorian)
**Date:** 2026-07-25
**Tracker:** DOR-501
**Project:** Agents as First-Class Operators (phase 4)

## The problem

DorkOS asks a person before an agent does something that cannot be undone. That gate is real and it is enforced in the right place. What is missing is the other half: **there is no supported way to turn it off, for anyone, anywhere.**

### What is actually in the tree

Verified on this branch, based on `origin/main` at `817e4b832`.

**One capability in the whole server is `destructive`.** `marketplace.uninstall`, at `apps/server/src/services/marketplace-mcp/marketplace-capabilities.ts:238`. A grep for `tier: 'destructive'` across `apps/server/src` (excluding tests) returns two lines, and only that one is a capability declaring its tier: the other (`apps/server/src/routes/marketplace.ts:285`) is a synthetic refusal payload a route builds when the gate cannot be reached, so it reports a tier rather than setting one. `marketplace.install` is tier `act` (`marketplace-capabilities.ts:216`) and `marketplace.create_package` is tier `act` (`marketplace-capabilities.ts:265`).

**So the thing users experience as "the approval gate" is really two mechanisms, not one.**

1. The **capability tier gate**, `enforceCapabilityTier` (`apps/server/src/services/core/capabilities/tier-enforcement.ts:479`). Since DOR-467 it is called from inside `registry.invoke` (`apps/server/src/services/core/capabilities/registry.ts:387`), so every surface reaching a capability through the registry is gated by construction rather than by each adapter remembering to call it. The invoke route and the MCP projection now just call `registry.invoke` (`apps/server/src/routes/capabilities-invoke.ts:96`, `apps/server/src/services/core/capabilities/mcp-projection.ts:191`) and translate a refusal into their own envelope. It gates `destructive` only: `observe` returns allowed at `tier-enforcement.ts:491`, `act` returns allowed at `tier-enforcement.ts:518`.
2. The **marketplace's own confirmation step**, a separate and older flow. It is what actually stops an install or a package creation, because those are tier `act` and the tier gate waves them straight through.

The user-facing guide describes all three actions as things that wait for you (`docs/guides/action-approvals.mdx:55-59`), and that is accurate about behavior. It just is not one mechanism underneath.

**The only bypass in the tree is scoped to tests.** `MARKETPLACE_AUTO_APPROVE` is declared at `apps/server/src/env.ts:44`. Its docstring reads, verbatim (`env.ts:42-43`):

```
// Marketplace MCP — when '1', auto-approves every install/uninstall/create
// confirmation request without prompting the user. Used by CI and tests.
```

It is read in exactly one place, `apps/server/src/index.ts:1592`, to choose `AutoApproveConfirmationProvider` over `TokenConfirmationProvider`. Three facts about it matter:

- It only short-circuits the **marketplace confirmation step**. It has no connection to the tier gate. A grep of `apps/server/src/services/core/capabilities/` and `apps/server/src/services/core/approvals/` for `AUTO_APPROVE`, `autoApprove`, and `permissionMode` returns zero hits in both directories. Confirmed by running it.
- The docstring's "CI" claim does not hold. There are zero hits for the variable anywhere under `.github/`. Its only setter in the whole repository is one eval case, `packages/evals/src/suite/operate.ts:495`.
- It is undocumented and undiscoverable. It is absent from `.env.example` (which has no line matching `approv` at all) and absent from `contributing/environment-variables.md`. Its only prose mention is `contributing/external-agent-marketplace-access.md:84`.

So an operator who wants an agent to act without being asked has nothing. Not a setting, not a flag they are told about, not a per-agent choice.

### Why that is a safety problem, not a convenience problem

Kai runs ten agents across five projects. Every package install, every uninstall, every scaffolded package stops and waits for him. A gate that interrupts constantly is a gate people learn to clear without reading. **A user who has been trained to click through is worse protected than one who is asked rarely and means it.** The gate stops being a decision and becomes a speed bump.

This is not hypothetical for this codebase. The whole point of the card's careful wording (`tier-enforcement.ts:346-374`, which describes how a requester cannot forge the sentence a person reads) is that the person actually reads it. Volume is the thing that quietly destroys that.

### The second problem: it is disconnected from the setting users will assume governs it

Runtime **permission mode** (`packages/shared/src/schemas.ts:28`: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `auto`) governs what the agent does with its own tools inside a session: writing files, running commands. The tier gate governs what an agent asks DorkOS itself to do. They do not know about each other.

A user can set `bypassPermissions`, which the UI labels "Bypass All" (`apps/client/src/layers/features/status/ui/PermissionModeItem.tsx:65-72`) and "Full Access" (`apps/client/src/layers/entities/binding/ui/BindingAdvancedSection.tsx:45-66`) and "Full autonomy" (`apps/client/src/layers/features/tasks/ui/TaskFormInner.tsx:287`), and still be stopped by a DorkOS approval card. Three different labels, all of which promise the user that nothing will ask them again, and all of which are wrong about this one thing.

The docs already try to paper over the seam with cross-links (`docs/guides/tool-approval.mdx:19-23` and `docs/guides/action-approvals.mdx:16-20`). Documentation is not the fix for a control that lies.

**A correction to the framing this work started from.** There is no per-agent permission mode. Permission mode is a property of a _session_ (`PATCH /api/sessions/:id`), a _channel binding_ (`BindingAdvancedSection.tsx:162-171`), and a _scheduled task_ (`packages/db/src/schema/tasks.ts:16`, column default `acceptEdits`). It is not stored on an agent. This matters for two reasons, both taken up below.

## What we are deciding

1. Where per-agent trust is stored, such that an agent cannot grant itself trust.
2. How fine-grained the trust is.
3. Whether trust expires.
4. What the approval card offers, and how a standing grant stays findable and revocable.
5. How an auto-approved destructive action is still audited.
6. What replaces `MARKETPLACE_AUTO_APPROVE`.

## Options considered

### A. Where does per-agent trust live?

This is the question that can sink the feature, because the wrong answer hands agents the switch that turns off their own supervision.

**A1. In `.dork/agent.json`, next to the agent's other settings.** Rejected, and it is worth being precise about why, because it is the obvious place and it is a trap.

Agent storage is file-first (ADR-0043): the manifest on disk is the source of truth and the SQLite `agents` table is a derived cache. The repo's own rule file states the consequence plainly. The reconciler "runs every 5 minutes and syncs **file → DB**" and "also **rebuilds the DB from files**", auto-importing any `.dork/agent.json` that is missing from the DB (`.claude/rules/agent-storage.md:58-62`).

So a trust field in `agent.json` would be a field where **the file always wins**. An agent that can write a file, which is every agent with a Write tool or a shell, edits its own manifest and is trusted within five minutes. There is no signature, no integrity check, and no reconciliation direction that would ever overwrite it, because file-beats-DB is the designed behavior, not a bug. Correcting that would mean inverting ADR-0043 for one field, which is exactly the kind of special case that rots.

**A2. In the `agent_identity` SQLite table, next to `tierCeiling`.** Tempting and nearly right. `tierCeiling` already lives there per agent (`packages/db/src/schema/agent-identity.ts:50`), it is deliberately not in `agent.json` (the agent-trust spec is explicit that the manifest never holds identity secrets), and it is the existing per-agent knob on this exact axis.

Rejected as the _home for the setting_, for one reason: the product owner's requirement is that the setting be classified in `config-write-policy.ts` from day one, and that table classifies leaves of `UserConfigSchema`. A DB column has no such classification and no drift guard. But A2 is not wasted: see the ceiling invariant below, which we get from it for free.

**A3. In `~/.dork/config.json`, classified `operator-only`.** Chosen for the _policy_, with grants themselves in SQLite. This is the same store as `auth.enabled` and `server.boundary`, protected by the same mechanism that already exists for exactly this threat.

`CONFIG_WRITE_POLICY` (`apps/server/src/services/core/operator/config-write-policy.ts:120-285`) classifies every config leaf as `agent-writable` or `operator-only`, and `findOperatorOnlyPaths` (`config-write-policy.ts:332`) refuses a patch that touches an operator-only path. The module's own doc states the line: a field is operator-only "when changing it, on its own, removes or widens a security control" (`config-write-policy.ts:49-50`). A switch that turns off the destructive gate is the cleanest possible instance of that line.

Critically, **the classification is enforced by a drift guard, not by discipline.** The table's doc comment says the guard "asserts it, so adding, renaming, or removing a config field fails the build until this table carries a deliberate verdict for it" (`config-write-policy.ts:112-115`), and the `adding-config-fields` skill names the test that runs it (`apps/server/src/services/core/operator/__tests__/config-write-policy.test.ts`). A new leaf with no verdict is a red build. That is a real guarantee, not a convention.

There is already precedent for a record-shaped operator-only field: `providers` is a `z.record` carrying a single `operator-only` verdict (`config-write-policy.ts:284`), and `findOperatorOnlyPaths` matches descendants, so `{ providers: { anthropic: '…' } }` is caught as a descendant of the guarded path (`config-write-policy.ts:319-331`).

**Why grants themselves go in SQLite instead of config.json.** The agent-trust spec already answered this shape of question and we should not answer it differently: "Approval persistence? **(RESOLVED)** SQLite table (derived data, not user-owned files). Rationale: approvals are operational state like tasks runs, not identity like `agent.json`" (`specs/agent-trust/02-specification.md:97`). A grant has a creation time, an expiry, and a revocation. That is operational state. Config holds the policy (may standing grants exist at all, and for how long); SQLite holds the instances.

### B. How fine-grained?

**B1. One global on/off.** Rejected. It is the crude, dangerous option, and it fails the actual user sentence. Kai does not want "stop asking"; he wants "stop asking about _this_ agent."

**B2. Per capability, across all agents.** Rejected, and it is the worst of the set. "Never ask about removing packages" means the agent installed five minutes ago inherits the trust earned by DorkBot over three months. Trust is a property of who is asking, and this option throws away exactly that.

**B3. Per agent, covering everything that agent might ask.** This is what Kai says out loud, and it was the leading option until a fact changed it.

Today there is one destructive capability and three gated actions. The user-facing docs warn that this set is expected to grow: scheduled tasks, agent-to-agent messages, agent discovery, and extensions are named as "not covered yet" (`docs/guides/action-approvals.mdx:65-71`). A blanket per-agent grant made today, when three actions ask, would **silently widen** to cover every action added later. The user consented to something smaller than what they end up with, and nothing tells them. That is the same defect shape as a field being safe only because it is currently absent.

**B4. Per agent, per capability.** Chosen.

The objection to this option is that a matrix of agents times capabilities is something nobody will maintain. That objection is right about a settings screen with N by M checkboxes, and we are not building one. **The grants are a ledger, not a matrix.** A row appears when a person answers a real approval card and chooses to make that answer standing. Nobody fills in a grid. Today the realistic size is one row per agent the user actually trusts.

What this buys, concretely: a capability that becomes destructive next month has no grant, so it asks. The consent stays the size it was when it was given. This is enforced by the schema having no wildcard value to write, not by anyone remembering.

### C. Does trust expire?

**C1. Forever, until revoked.** Rejected. A standing grant with no end is a permanent hole that the person who opened it will not be thinking about in a month.

**C2. Time-boxed, sliding on use (the `sudo` model).** Rejected, and this is the interesting one. `sudo` refreshes its window every time you use it. Copying that here would mean **the agent controls its own expiry**: an agent that keeps acting keeps its trust alive indefinitely, so a busy or looping agent is exactly the one that never has to ask again. That inverts the property we want. It is the same class of mistake as keying a gate on whether the caller presented a credential, which `tier-enforcement.ts:40-62` was rewritten to remove.

**C3. Time-boxed, absolute from the moment it was granted.** Chosen. The window does not move, whatever the agent does. Default eight hours: one working session, long enough that Kai's afternoon is not forty cards, short enough that it cannot survive into a day the person never thought about.

This mirrors reasoning the codebase already committed to for the approval window itself: two hours, chosen so it survives a meeting but "deliberately does NOT survive a night's sleep" because "consent has to stay contemporaneous with the request a person actually read" (`apps/server/src/services/core/approvals/approval-service.ts:50-63`).

The window is configurable but bounded, following the shortenable-not-lengthenable pattern already used for `DORKOS_APPROVAL_TTL_MS` (`approval-service.ts:106-109`, and its env declaration at `env.ts:45-52`). There is no value meaning "forever".

### D. What does the approval card offer?

The card today has exactly two buttons, "Don't allow" and "Allow" (`apps/client/src/layers/features/approvals/ui/ApprovalCard.tsx:104-120`), with nothing pre-selected, which the guide calls out as deliberate (`docs/guides/action-approvals.mdx:51`).

**D1. Add "Allow and stop asking".** Chosen, with conditions, because the honest version of this button is the whole feature and the careless version is a dark pattern.

The risk is real: a one-time decision quietly becoming a standing grant is how consent gets manufactured. The mitigations are that the button names its exact scope and duration in its own label, that it only appears when there is a named agent to grant to, that it is off unless the operator turned the whole mechanism on, and that every grant is listed and revocable in one findable place. **A grant a user cannot find later is a dark pattern**, so findability is a requirement of the feature, not a nice-to-have.

**D2. A settings-only control, with no card button.** Rejected as the only path. It is safer but it puts the control at the moment of least motivation. The person learns they want this _while_ clearing the fifth card, not while browsing settings.

### E. What replaces `MARKETPLACE_AUTO_APPROVE`?

It is deleted. AGENTS.md is explicit that superseded things get removed rather than tolerated.

The migration cost turns out to be one eval case, not a fleet of CI jobs, because the "used by CI" claim in its docstring is not true (zero hits under `.github/`). Its sole setter is `packages/evals/src/suite/operate.ts:495`.

And the replacement already exists. The governance suite added for DOR-498 drives real approvals through the real API with an `approvalPolicy`, including a granting case (`packages/evals/src/suite/governance.ts:831`) and a denying one (`governance.ts:760`). The harness can already answer an approval, which is precisely what the most recent commit on this branch's base records (`817e4b832`, "the harness can answer an approval, so the governance eval proves both halves"). So the install eval moves onto the mechanism that exercises production code instead of a test-only branch. That is a strictly better test, not a workaround.

One thing the deletion must not do is quietly break installs. Because `marketplace.install` and `marketplace.create_package` are tier `act`, the tier gate never gates them and `MARKETPLACE_AUTO_APPROVE` is currently the _only_ thing that can make them proceed unattended. So the new setting has to satisfy the marketplace confirmation step too, or "stop asking" will stop the uninstall card and leave the install card, which is the exact "don't ask did not mean don't ask" failure one level down.

## The shape that wins

One setting, off by default, that an agent cannot reach:

- **`approvals.standingGrants`** (boolean, default `false`) and **`approvals.trustWindowMinutes`** (default 480, bounded) in `~/.dork/config.json`, both classified `operator-only` so the drift guard keeps them classified.
- **Grants** as rows in a new SQLite table, keyed by agent path and capability id, with an absolute expiry, created only through the human decision path and revocable from one place.
- **Enforced inside `enforceCapabilityTier`**, after the ceiling check, and at the marketplace confirmation step, so one setting governs everything that asks.

Three properties make it safe, and each is a consequence of the design rather than a rule someone has to follow:

1. **Only an identified agent can be trusted.** Grants key on agent path. A caller that presents no identity can never match one, so dropping a credential can only ever get you the gate, never past it. This is the mirror image of the reasoning at `tier-enforcement.ts:64-79`, where the ceiling was made universal so that shedding a credential could not widen reach.
2. **A grant can never exceed the ceiling.** The `tierCeiling` check runs before the approval path (`tier-enforcement.ts:496-514`) and returns a refusal that is explicitly not approvable. An agent capped at `act` stays capped whatever grants exist, and we get that for free by putting the grant check after the ceiling check. Stated honestly: this is structural, not currently active. The only production caller of `mint()` passes just the agent path and display name (`apps/server/src/services/core/agent-identity/agent-token-env.ts:52-55`), so every agent sits at the default `destructive` ceiling and nothing is capped today.
3. **The agent that asked cannot create the grant.** Grant creation travels the same authority check as deciding an approval, `resolveDecisionAuthority` (`apps/server/src/services/core/approvals/decision-authority.ts:146`), which refuses any caller presenting an agent identity (`decision-authority.ts:152-159`) or holding an approval token (`decision-authority.ts:163-170`).

### The correction that property 3 needed

Property 3 as written above is **not sufficient**, and review caught it by running the attack rather than reading the code. `resolveDecisionAuthority` refuses an agent that _names itself_. It does not refuse an agent that simply omits its headers, and under the default `local-trust` posture nothing can: the resolver returns allowed for a caller presenting neither an agent header nor an approval token (`decision-authority.ts:172-174`). The same omission also skips the operator-only check on `PATCH /api/config`, because that check sits inside `if (!trustedCaller(...))` (`apps/server/src/routes/config.ts:231-232`). Two omitted headers walk the whole chain.

So a fourth property is required, and it costs something real:

4. **Creating a standing permission requires a session cookie, which means standing permissions require login to be on.** A cookie is the only signal that separates the cockpit from a header-stripping caller on loopback. With login off there is none, and "trust this agent" is not a statement DorkOS can evaluate, so the feature is disabled rather than approximated.

The option of shipping it anyway under `local-trust` was considered and rejected. It would mean a control that claims to distinguish callers it demonstrably cannot, which is the exact failure `decision-authority.ts:40-42` refuses: inventing a check the agent could trivially satisfy "would be worse than the gap, because it would be a lie." Full reasoning and the reproduced chain are in §3.0 of the specification.

## Open questions carried into the specification

- Exactly how the trust check is threaded into the marketplace confirmation provider, given that provider is constructed at boot (`index.ts:1591-1594`) while the grant lookup is per call.
- Whether the grants roster is exposed to agents through `config_get`, or withheld.
- Where the setting is surfaced, given the finding that permission mode has no per-agent home to sit next to.

## References

- `specs/agent-trust/02-specification.md`: the tier gate, the approval primitive, and the resolutions this spec inherits.
- `.claude/rules/agent-storage.md`: file-first write-through and the reconciler behavior that rules out `agent.json`.
- `.claude/skills/adding-config-fields/SKILL.md`: the nine-step config change lifecycle.
- `docs/guides/action-approvals.mdx`: the user-facing gate, including the honest limits section this spec extends.
