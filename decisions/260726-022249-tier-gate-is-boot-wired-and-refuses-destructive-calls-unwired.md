---
id: 260726-022249
title: The tier gate is wired once at boot into a module global, and an unwired gate refuses destructive calls
status: accepted
created: 2026-07-26
spec: agent-trust
superseded-by: null
---

# 260726-022249. The tier gate is wired once at boot into a module global, and an unwired gate refuses destructive calls

## Status

Accepted. Written after the fact on 2026-07-26: the decision was made in code during DOR-452 and materially reshaped by DOR-467, and this record describes what exists now rather than what was first built.

## Context

Tier enforcement needs the approval service, because a destructive capability's answer is "ask a person" and the approval store is who it asks. Everything else in `services/core` takes its dependencies by injection, and `services/core/approvals` deliberately exposes no singleton, so injection was the expected shape here too.

It did not fit. The two MCP adapters that had to be gated are constructed deep inside per-request and per-session factories, and neither factory carries a path for one more service handle; threading one through would have meant changing every intermediate signature for a dependency only the innermost frame uses. The spec had assumed a threaded parameter, `enforceCapabilityTier(identity, capability, approvalToken?)`.

The follow-on question is what happens when the wiring is absent. A gate with no approval service cannot ask anyone anything, and the honest options are opposite: run the operation unenforced, or refuse it.

## Decision

We will hold the gate's dependencies in a module-level variable set once at boot by `initCapabilityTierGate` (`apps/server/src/services/core/capabilities/tier-enforcement.ts:305` and `:324`), with `resetCapabilityTierGate` as an explicit test-only seam. The approval service itself stays injected into that call; the module global holds the wiring, not a service locator.

The ordering guarantee is narrower than it first looks, and worth stating precisely. `index.ts` mounts `/mcp` and every `/api/*` router BEFORE it wires the gate (the last router lands at `index.ts:1626`, the wiring at `:1657`). What makes that safe is `app.listen` at `:1711`: the server accepts no connection until after the gate is wired, so no request can reach an unwired gate. "Wired before anything is mounted" would be false.

An unwired gate REFUSES a destructive call (`enforcement_unavailable`, `approvable: false`) rather than allowing it (`tier-enforcement.ts:526-535`). With no approval service there is nobody to ask, and running the operation would turn a wiring mistake into an unreviewed irreversible action.

Since DOR-467 the gate is called from inside `registry.invoke` (`apps/server/src/services/core/capabilities/registry.ts:386-396`) rather than from each adapter, so every registry-borne surface is gated by construction. A caller that owns its own effect, which today means the legacy marketplace routes, reaches the same gate through `authorizeCapability` (`tier-enforcement.ts:723`, which reaches the gate at `:757`, used at `routes/marketplace.ts:297`), whose importers are pinned by `__tests__/gate-bypass-scan.test.ts` so a second one cannot appear unnoticed. `enforceCapabilityTier` is deliberately withheld from the package barrel while `authorizeCapability` is exported (`capabilities/index.ts:25-28`), which is what keeps those two the only ways in. The hand-maintained choke-point list that preceded this is retired.

The one way past the gate is a `TrustedCaller` marker, an instance of a class `trusted-caller.ts` does not export, so no value arriving as JSON can be one; a `trusted` field that is present but not a genuine marker is refused loudly rather than downgraded to untrusted (`registry.ts:350-356`).

## Consequences

### Positive

- A new adapter, transport, or route inherits enforcement by calling `registry.invoke`. Forgetting to gate is no longer possible for a caller that goes through the registry, which is the shape the original hand-maintained list of gated paths could never guarantee.
- The failure mode of a wiring bug is a refused destructive call and an audit line, not a silent unreviewed one.
- Parsing happens once inside `invoke` and the gate binds to that same parsed value, so the approved action and the executed action cannot diverge by construction. The conformance assertion that previously guarded the double parse is gone because what it guarded is gone.

### Negative

- **The refusal covers `destructive` only.** `observe` and `act` return allowed before the wiring is ever checked (`tier-enforcement.ts:524` precedes `:526`), so an unwired gate does not stop them. This is deliberate, since those tiers need no approval service, but "the gate fails closed" is false if read as covering every tier.
- A module global is genuinely at odds with the dependency-injection convention in `services/core`, and it is load-bearing rather than incidental. It survives on the argument that the alternative touches many signatures for one frame's benefit, which is a judgment about this codebase's shape and could stop being true.
- Test isolation now depends on remembering `resetCapabilityTierGate`; a suite that does not reset it can inherit another suite's wiring.
- The trusted-caller marker's protection against in-process forgery is narrower than "unforgeable": code already holding a real marker can make another, and `trustedCaller` is exported. What non-export actually buys is that a call-site scan on one token stays exhaustive, and that scan is the in-process boundary. Anyone strengthening this should read `trusted-caller.ts` rather than assume the marker is a capability token.
