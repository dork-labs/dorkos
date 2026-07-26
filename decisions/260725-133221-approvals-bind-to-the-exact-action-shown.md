---
id: 260725-133221
title: An approval binds to the exact action the person saw
status: accepted
created: 2026-07-25
spec: agent-trust
superseded-by: null
---

# 260725-133221. An approval binds to the exact action the person saw

## Status

Accepted. Amended 2026-07-25: the decision window moved from ten minutes to two hours
(`APPROVAL_TTL_MS`) once the cockpit gained a global pending-approval marker that reaches a person
on every route. Ten minutes only ever worked for an operator already watching the dashboard, which
was the one place a pending approval appeared. Nothing else in this decision changes: the binding,
the single-use conditional write, and the consume-time expiry check all stand.

## Context

The marketplace's pre-existing confirmation flow issued a token that authorized an _operation_, not a specific set of arguments, so a token could be redeemed against different inputs than the ones described to the person who approved it. Generalizing that flow into a reusable primitive made the gap explicit and repeatable: review found that binding the package name alone let an approval for "uninstall, keeping saved data" be spent on `purge: true` (deleting that package's data and `secrets.json`), redirected at a different project, or, for installs, resolved against a different marketplace than the card named because an omitted field was silently defaulted into the hash while the raw value reached the mutation.

## Decision

We will bind every approval to `(capabilityId, sha256(stableStringify(parsed input)))` and require that binding at `consume`. Absence is bound as absence (`?? null`), never as a substituted default, so an omitted argument cannot hash the same as a supplied one. The hash covers the _parsed_ input that will execute, with a conformance assertion that every destructive capability's schema is parse-idempotent so the hashed and executed values cannot diverge. Every argument that changes what happens to the machine is bound; free-text metadata that only changes what a package says about itself is deliberately not, since binding a field the person never saw protects nothing. A mismatch is refused _without_ spending the approval, so the honest retry still works. Approvals are single-use with a conditional write, expire after a bounded decision window (`APPROVAL_TTL_MS`, two hours since the amendment above) checked at consume time, and the card's identity region (title and tier) is derived from the capability registry rather than supplied by the caller.

## Consequences

### Positive

- Consent means one thing: the action described on the card, once, soon. Retry-with-different-arguments is structurally refused rather than trusted.
- The card cannot be spoofed by the requester: title and tier come from the registry, and the summary is composed server-side from the same values that get hashed. **(Overstated as written — see Errata, 2026-07-25.)**
- The invariant is stated where it is enforced, so adding an argument that reaches a mutation without adding it to the binding is a documented, reviewable mistake.

### Negative

- Every new destructive capability owes its binding a deliberate field-by-field decision; the compiler cannot tell you that a newly added argument changes machine effect.
- A non-idempotent Zod `.transform()` on a destructive schema would break the hash identity; today only a conformance assertion catches that, not the type system.

## Errata (2026-07-25)

The consequence "The card cannot be spoofed by the requester" was overstated, and adversarial review reproduced two ways it failed. The code was fixed to match the claim rather than the claim relaxed.

1. **The summary could be made to lie.** Arguments were joined with unescaped `, ` and `: ` separators, so `{ name: 'pkg, purge: no', purge: true }` rendered a fake `purge: no` pair BEFORE the real `purge: yes`, and padding the injected value pushed the true one past the summary's length cap and out of the card's `line-clamp-2`. Caller-supplied values are now quoted and escaped, each capped independently before the sentence is capped, and a destructive card is never clamped. Requester labels get the same treatment: an agent's `displayName` comes from its own `agent.json`, which it can rewrite through an `act`-tier capability.
2. **Secret-shaped values reached the card, the SSE broadcast, and the agent-readable pending list.** `confirmationToken` is a declared field of the only destructive capability's input, and the generic renderer echoed it, contradicting the invariants stated verbatim in `approval-events.ts` and `approval-schemas.ts`. A capability now declares `approvalDisplayFields`; undeclared inputs drop fields whose name says secret; and a final sweep replaces token-shaped runs where the summary is stored, which covers the marketplace confirmation provider's own sentences too.

Superseded detail (DOR-467): the parse-idempotence conformance assertion named above is gone, because the double parse it existed to make safe is gone. `registry.invoke` now parses once and gates on that single value, which is also the value the handler runs, so the hashed and executed values cannot diverge by construction rather than by assertion. Everything else in this decision stands.

Separately, the binding hash silently unbound anything `stableStringify` cannot canonicalize (`Date`, `Set`, `Map`, class instances: `{ at: new Date(0) }` and `{ at: new Date(9e11) }` produced the same digest). Latent, since every destructive input is scalars today, and invisible to the parse-idempotence assertion. `hashApprovalInput` now rejects non-plain values outright and the gate turns that into a refusal (`input_not_bindable`) rather than binding an approval to a hash that ignores part of the action.
