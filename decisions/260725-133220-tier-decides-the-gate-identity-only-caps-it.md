---
id: 260725-133220
title: The action's tier decides the gate; identity only caps it
status: accepted
created: 2026-07-25
spec: agent-trust
superseded-by: null
---

# 260725-133220. The action's tier decides the gate; identity only caps it

## Status

Accepted

## Context

Phase 2 declared an observe/act/destructive tier on every capability but enforced nothing. When phase 3 built enforcement, the first implementation returned `allowed` whenever no agent identity resolved, on the reasoning that "absent identity = today's behavior" (spec §3.1). That resolution was about _attribution_, and applying it to enforcement made the gate optional: the CLI attaches its identity header only when `DORKOS_AGENT_TOKEN` is in the environment, so unsetting one variable, or sending a bare `curl` to the locally-open API, skipped the gate entirely. Review reproduced it and confirmed the tier gate never ran; the action was still stopped only because `marketplace.uninstall` happens to carry its own legacy confirmation flow.

## Decision

We will gate on the capability's declared tier alone. `observe` passes; `act` passes and is attributed; `destructive` requires a granted approval bound to (capability id, input hash) whether or not the caller identified itself. An agent identity contributes exactly one thing to enforcement: its `tierCeiling`, which can only _narrow_ what the caller may do. Anonymous callers are a first-class gated case, audited under `actorType: 'system'` with `requestedBy` omitted rather than fabricated, and the approval card says plainly that DorkOS does not know who asked. Enforcement is called at all three choke points (the invoke route and both MCP adapters) and the conformance suite carries an identified _and_ an anonymous probe per path, where a missing probe is itself a violation.

## Consequences

### Positive

- Hiding does not help: dropping a credential can never widen what a caller may do, which is the only property that makes the gate worth having.
- Identity stays optional, so external MCP clients and human CLI use keep working (the original §3.1 concern) without weakening enforcement.
- Anonymous attempts are audited, so a caller trying to slip past leaves a record instead of a silence.

### Negative

- A human running `dorkos call` against a destructive capability now answers an approval card, a step they did not previously face.
- The three-choke-point list in the conformance fixture is hand-maintained; a genuinely new non-MCP adapter still needs someone to add its two probes. Moving the gate inside `registry.invoke` would fix this structurally but needs a trusted-caller concept for human-initiated internal callers first.

## Errata (2026-07-25)

Two places kept the very inversion this decision removed, both found by adversarial review after the ADR was accepted:

1. **The ceiling was identity-keyed.** `TIER_RANK[tier] > TIER_RANK[identity.tierCeiling]` only ran when an identity was present, so an agent capped at `act` was refused unapprovably while the same agent with `DORKOS_AGENT_TOKEN` unset reached the approvable path instead. Presenting a credential strictly cost privilege. Every caller now has a ceiling: an unidentified one is capped at `anonymousTierCeiling` (default `destructive`, so behavior is unchanged today), which makes the two paths comparable. The sentence above, "an anonymous caller has no ceiling to cap", was wrong and is superseded by this paragraph.
2. **Deciding was identity-keyed.** `POST /api/approvals/:id/grant` refused a caller that PRESENTED an agent identity and allowed everyone else, so omitting one header let a requester grant its own approval. Who may decide is now `resolveDecisionAuthority`: proof of an authenticated person when `auth.enabled` is true, and in the default login-off posture (`local-trust`) a refusal of any caller presenting an agent identity or an approval token, plus an Activity record naming the posture. That posture's honest limit — a credential-free caller with shell access is indistinguishable from the cockpit — is documented in `services/core/approvals/decision-authority.ts` and in `docs/guides/action-approvals.mdx`, not papered over.

The conformance suite gained `requesterDecideProbe` (the caller that asked cannot grant), so the second one is now falsifiable per PR the way the three-choke-point probes already were.
