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
- The card cannot be spoofed by the requester: title and tier come from the registry, and the summary is composed server-side from the same values that get hashed.
- The invariant is stated where it is enforced, so adding an argument that reaches a mutation without adding it to the binding is a documented, reviewable mistake.

### Negative

- Every new destructive capability owes its binding a deliberate field-by-field decision; the compiler cannot tell you that a newly added argument changes machine effect.
- A non-idempotent Zod `.transform()` on a destructive schema would break the hash identity; today only a conformance assertion catches that, not the type system.
