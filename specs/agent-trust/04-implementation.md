# Implementation: Agent Trust (program phase 3)

- **Completed:** 2026-07-25
- **Tasks:** 6/6 (DOR-446..451), all merged
- **PRs:** #442 (Docker eval isolation tier), #443 (agent identity + Activity attribution), #444 (eval CI cadence), #448 (approval primitive), #452 (tier enforcement), #454 (governance eval + trust docs)
- **ADRs:** 260725-133220 (tier decides the gate, identity only caps it), 260725-133221 (approvals bind to the exact action shown), 260725-133222 (eval isolation and cadence); discharges the "tier enforcement must target this endpoint first" consequence of 260723-050220

## What shipped

Destructive capabilities stop and ask a person, at all three choke points (the invoke route and both MCP adapters), keyed on the action's declared tier rather than on whether the caller identified itself. Approvals are single-use, expire after a bounded decision window, and are bound to the exact parsed input the person saw described. Agents carry per-agent identity tokens (hashed at rest, keyed on the stable `agentPath` so the ADR-0043 reconciler rebuild cannot destroy them, 7-day idle / 30-day absolute expiry) which supply Activity attribution and a `tierCeiling` that can only narrow what a caller may do. The eval harness gained genuine OS-level containment and an opt-in CI cadence.

## Deltas from the spec

- Enforcement is a boot-initialized module seam (`initCapabilityTierGate`) rather than a threaded parameter, because both MCP adapters are built inside per-request/per-session factories with no path for another handle. It fails closed (`enforcement_unavailable`) when uninitialized.
- The gate signature takes an options object, not the spec's `(identity, capability, approvalToken?)`, because it also needs the parsed input to hash and the surface's retry channel for its instructions.
- `AutoApproveConfirmationProvider` short-circuits rather than writing auto-granted rows, to keep CI and eval runs out of the audit trail. Verified scoped to the marketplace provider; it cannot reach the tier gate.
- The legacy `POST /api/marketplace/confirmations/:token` route was deleted rather than migrated (zero callers outside its own tests). Decisions refuse callers presenting an agent identity (403 `AGENT_CANNOT_DECIDE`). **Corrected 2026-07-25: the claim that deleting that route "closed a seam where a token holder could decide its own approval" was false.** The seam moved rather than closed — `POST /api/approvals/:id/grant` keyed on the PRESENCE of an agent identity, so a token holder that simply omitted the header still decided its own approval. See the follow-up below.
- `requestedBy` required threading the invocation context into `capability.invoke`, which the registry had never done.

## Verification

Conformance carries an identified and an anonymous destructive-gate probe per choke point, where a missing probe is itself a violation; falsifiability was reproduced independently by reseeding the identity-keyed defect and observing exactly the three anonymous probes fail. The governance eval (`governance-approval-gate`, quarantined pending a credentialed run) distinguishes the tier gate's `approval_required` payload from the marketplace's older `requires_confirmation` shape, with every asserted field name typecheck-pinned. Full monorepo suite green (29/29 tasks) at merge.

## Correction on record

During review of #452 the pre-fix consequence was initially stated as data loss ("purge runs with no card"). That was wrong for today's only destructive capability: `marketplace.uninstall` carries its own legacy confirmation flow which would have held. The real defect was that the tier gate did not run, the `approval_required` contract was not honored, and calls went unattributed, with protection resting on one handler's bespoke second gate. Recorded so nobody cites data loss for the pre-fix state.

The decision window shipped in this phase at ten minutes and was raised to two hours on 2026-07-25, when the cockpit gained a global pending-approval marker (ADR 260725-133221, amended). The phase shipped the primitive with no surface outside the dashboard section, so an approval requested while its operator was on `/session` expired with nobody ever told: ten minutes was only ever defensible for a person already watching that one page.

## Follow-up: five defects found by adversarial review (2026-07-25)

Two independent reviewers found that the human was optional and that the card a person reads could be made to lie. All were reproduced against the real code, and all are now fixed with a failing-first test each. Full detail is in the errata on ADRs 260725-133220 and 260725-133221; in brief:

1. **An agent could grant its own approval by omitting a header it controls.** The exact inversion `tier-enforcement.ts` was rewritten to remove, at the endpoint that decides. Replaced by `resolveDecisionAuthority` (`services/core/approvals/decision-authority.ts`), which requires an authenticated user when `auth.enabled` is true and, in the default login-off `local-trust` posture, refuses any caller presenting an agent identity or an approval token. The posture's honest limit is documented in code and in the user guide: with login off, a credential-free caller with shell access is indistinguishable from the cockpit, so the gate stops accidents and rule-following injected agents but not an adversary already running as you. Mitigation available in that posture is visibility, not prevention: every decision writes an Activity record naming its posture.
2. **The approval card could contradict the action it binds.** Unescaped argument joining let an injected value forge a second field and push the real one out of the clamp. Values are quoted, capped per value, and destructive cards are no longer clamped.
3. **Secret-shaped input values reached the card, the SSE broadcast, and the agent-readable pending list.** Fixed with a per-capability `approvalDisplayFields` allowlist, name-based dropping for undeclared inputs, and a token-shaped sweep at the storage choke point.
4. **A destructive call that actually ran was audited nowhere when the caller was unidentified.** The gate defers `allowed` audits to the invocation observer, which bailed on a missing identity. A destructive invocation is now always audited with its outcome. The gate also audits a destructive attempt that dies inside the approval store, which previously threw past `audit()`.
5. **`tierCeiling` was escapable by dropping identity.** Every caller now has a ceiling; an unidentified one defaults to `destructive`, so behavior is unchanged while the escape is gone.

Plus one latent 🟡: `stableStringify` silently unbound `Date`/`Set`/`Map`/class instances, so `hashApprovalInput` now rejects non-plain values and the gate refuses with `input_not_bindable`.

Conformance gained `requesterDecideProbe`, encoding the narrower invariant it can actually prove: a caller presenting an approval's own retry token cannot decide that approval. It deliberately does not encode the broader "anything that can reach `POST /api/capabilities/:id/invoke` cannot reach `POST /api/approvals/:id/grant`", which is false by design in the login-off posture; the identified-agent half is pinned by the route test instead. Falsifiability confirmed by reseeding: removing the token check fails the probe, and removing the agent check does not.

## Open follow-ups (tracked)

- Move enforcement inside `registry.invoke` as defense in depth so future adapters inherit it, retiring the hand-maintained choke-point list. Needs a trusted-caller concept for human-initiated internal callers.
- Promote the seven quarantined evals after a credentialed `claude-code-cheap` run.
- Per-agent capability policies beyond the tier ceiling.
- Fragment-gate versus curated-fragment reconciliation (workflow hygiene; hit seven times across the program).
