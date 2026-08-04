---
id: 260804-093319
title: Outbound delivery asserts a server-only non-exempt relay.bridge.* principal, and the consent gate finally enforces canReply
status: proposed
created: 2026-08-04
spec: chats-as-channels
superseded-by: null
---

# 260804-093319. Outbound delivery asserts a server-only non-exempt relay.bridge.\* principal, and the consent gate finally enforces canReply

## Status

Proposed. To be accepted when the `chats-as-channels` spec reaches `implemented`.

## Context

`canReply` was unenforced before this feature: `bindingAllowsInitiate` gated initiates, replies rode the blanket `agent:*` exemption, and `canReply` was read only into `__bindingPermissions`. The `InitiateConsentGate` is `(from, subject) => decision` - two strings - so it cannot see the entry, its `cascadeRoot`, the external-ref table, or the delivering author, and therefore cannot classify a delivery's provenance or run a sender check. And the HTTP route `POST /api/relay/messages` rejects a client-supplied `from` only when `isConsentExemptPrincipal(from)` is true, so a new non-exempt principal would sail straight through and let any local caller publish arbitrary text into the chat as the bot.

## Decision

We will have `deliver` publish under a new principal `relay.bridge.{reply|initiate}.{adapterId}.{chatId}`, with the classification carried **in the principal** because that string plus the subject is all the gate sees - and placed ahead of the variable-length tail so a dotted chat id cannot shift the parse. The gate gains **one** non-exempt branch for `relay.bridge.*` that reads the classification from its fixed segment and enforces `enabled && canReply` for a reply and `enabled && canInitiate` for an initiate; `deliver` itself classifies provenance (room-scoped: same room and same chat) and independently checks the delivering author is the bound agent or operator. The HTTP route gains a **second, wider** predicate `isServerOnlyPrincipal = isConsentExemptPrincipal(from) || from.startsWith('relay.bridge.')`, used by the route only, leaving `isConsentExemptPrincipal` untouched at exactly three branches.

## Consequences

### Positive

- `canReply` becomes a real switch for the first time, and a cross-room cascade root can no longer launder an initiate past `canInitiate: false` (the same-room-same-chat provenance rule closes it).
- Trusting the caller's asserted classification is safe because `relay.bridge.*` is server-only: no client can assert it, so only `deliver` reaches the branch.
- The two predicates live side by side with the wider one named for what it guards ("a client may not assert this") versus the narrower one ("the gate skips this") - collapsing them is exactly how the hole opened, so keeping them apart is the guardrail.

### Negative

- Two predicates that look almost identical must be kept distinct; a later "simplification" that merges them reopens the hole, so a paired test pins that `isConsentExemptPrincipal` still answers false for `relay.bridge.*`.
- Enforcement is split across two files (classification and author check in `deliver`, the two switches in the gate), which a reader must hold together to see the whole picture.
- The classification's position in the principal string is load-bearing and unobvious; it is documented, but a future grammar change must preserve the fixed-segment parse.
