# Implementation: Agent Trust (program phase 3)

- **Completed:** 2026-07-25
- **Tasks:** 6/6 (DOR-446..451), all merged
- **PRs:** #442 (Docker eval isolation tier), #443 (agent identity + Activity attribution), #444 (eval CI cadence), #448 (approval primitive), #452 (tier enforcement), #454 (governance eval + trust docs)
- **ADRs:** 260725-133220 (tier decides the gate, identity only caps it), 260725-133221 (approvals bind to the exact action shown), 260725-133222 (eval isolation and cadence); discharges the "tier enforcement must target this endpoint first" consequence of 260723-050220

## What shipped

Destructive capabilities stop and ask a person, at all three choke points (the invoke route and both MCP adapters), keyed on the action's declared tier rather than on whether the caller identified itself. Approvals are single-use, expire in ten minutes, and are bound to the exact parsed input the person saw described. Agents carry per-agent identity tokens (hashed at rest, keyed on the stable `agentPath` so the ADR-0043 reconciler rebuild cannot destroy them, 7-day idle / 30-day absolute expiry) which supply Activity attribution and a `tierCeiling` that can only narrow what a caller may do. The eval harness gained genuine OS-level containment and an opt-in CI cadence.

## Deltas from the spec

- Enforcement is a boot-initialized module seam (`initCapabilityTierGate`) rather than a threaded parameter, because both MCP adapters are built inside per-request/per-session factories with no path for another handle. It fails closed (`enforcement_unavailable`) when uninitialized.
- The gate signature takes an options object, not the spec's `(identity, capability, approvalToken?)`, because it also needs the parsed input to hash and the surface's retry channel for its instructions.
- `AutoApproveConfirmationProvider` short-circuits rather than writing auto-granted rows, to keep CI and eval runs out of the audit trail. Verified scoped to the marketplace provider; it cannot reach the tier gate.
- The legacy `POST /api/marketplace/confirmations/:token` route was deleted rather than migrated (zero callers outside its own tests), which also closed a seam where a token holder could decide its own approval. Decisions now refuse callers presenting an agent identity (403 `AGENT_CANNOT_DECIDE`).
- `requestedBy` required threading the invocation context into `capability.invoke`, which the registry had never done.

## Verification

Conformance carries an identified and an anonymous destructive-gate probe per choke point, where a missing probe is itself a violation; falsifiability was reproduced independently by reseeding the identity-keyed defect and observing exactly the three anonymous probes fail. The governance eval (`governance-approval-gate`, quarantined pending a credentialed run) distinguishes the tier gate's `approval_required` payload from the marketplace's older `requires_confirmation` shape, with every asserted field name typecheck-pinned. Full monorepo suite green (29/29 tasks) at merge.

## Correction on record

During review of #452 the pre-fix consequence was initially stated as data loss ("purge runs with no card"). That was wrong for today's only destructive capability: `marketplace.uninstall` carries its own legacy confirmation flow which would have held. The real defect was that the tier gate did not run, the `approval_required` contract was not honored, and calls went unattributed, with protection resting on one handler's bespoke second gate. Recorded so nobody cites data loss for the pre-fix state.

## Open follow-ups (tracked)

- Move enforcement inside `registry.invoke` as defense in depth so future adapters inherit it, retiring the hand-maintained choke-point list. Needs a trusted-caller concept for human-initiated internal callers.
- Promote the seven quarantined evals after a credentialed `claude-code-cheap` run.
- Per-agent capability policies beyond the tier ceiling.
- Fragment-gate versus curated-fragment reconciliation (workflow hygiene; hit seven times across the program).
