---
id: 261125-114705
title: Capability HTTP surfaces carry an audience, a network mode and request facts; a reasoned allowlist holds the routes that stay by hand
status: accepted
created: 2026-11-25
spec: null
superseded-by: null
amends: [261123-170830]
---

# 261125-114705. Capability HTTP surfaces carry an audience, a network mode and request facts; a reasoned allowlist holds the routes that stay by hand

## Status

Accepted (API lead, DOR-4978, 2026-11-25; the network modes decided by Security on DOR-4978 the same day).

**Amends** [261123-170830](261123-170830-http-api-is-a-projection-of-capabilities.md), which stays Accepted. It said a capability's `http` surface grows to carry audience and that a few hand routes stay on one allowlist. This record fixes what those mean, now that routes are moving onto the mount.

## Context

Moving a hand route onto the capability mount also makes it something every agent can call, through `POST /api/capabilities/{id}/invoke`, `dorkos call` and any MCP surface. The first moves showed what that costs when nothing stops it: an agent could mark its own edits reviewed with no approval and no audit record, read the titles of a person's private chats from a workspace list, or reach a person-only action through `permissions.request_access`. Hand routes had guarded these with their own checks, each written differently. Several routes also need facts about the request (is this the owner, in person, at this computer) that a capability's input does not carry, and some are reachable from the network on purpose.

## Decision

1. **Audience.** An HTTP surface may declare `audience: 'person'`. The one gate, inside `registry.invoke`, refuses such a capability with `person_only` unless the call carries a person proof, so every path is covered, including `request_access`. Only the HTTP dispatcher mints the proof, from the same caller check the person-only hand routes used: no agent header, no approval token, no API key and no `Authorization` header, and a person session when login is on. A person-only capability declares no MCP surface. The catalog shows the audience. A capability's own REST path (never `/invoke`) mints that proof for every `observe` call, and with it, and with no API key either, the read skips only an area Blocked for agents by the area's default or the preset (never an action-level setting or a floor), recorded in the audit log as a `rest-proof` read (DOR-4978).
2. **Request facts, never headers.** A handler that needs to know about the request reads `context.request`: a few yes/no answers the dispatcher works out (clears the account owner bar, proves the owner in person, at this computer with no program key), computed only when read. Never a header, a cookie or a key. Absent on MCP, in-session and in-process calls, where every answer counts as no.
3. **Network modes.** One field, `wifi`, with two meanings kept apart. `wifi: 'lowers-power'` (which replaced `allowFromWifi`) means the action lowers an agent's power (today, only `agent.pause`). An action a person may take from another device on purpose declares `wifi: 'person-held'`, and the mount, not the handler, enforces the existing network hold for it. A test pins the exact set of surfaces with any network mode, so adding one is a reviewed change.
4. **Confirm-first.** An action that needs the person to confirm it's them uses a capability-level confirm-first hold bound to the person's session and device, single-use and short-lived, that no agent path can satisfy.
5. **The allowlist.** `apps/server/src/http/hand-routes/allowlist.ts` holds the routes that stay by hand, each with a category and a one-line reason: streams, byte uploads and downloads, OAuth and webhook callbacks, sign-in handshakes that set cookies, HTML pages, health and docs, and the invoke route. A census test keeps every `/api` route classified as a capability, allowlisted or pending; the pending list may only shrink, and the API lint's `hand-registered-path` rule turns blocking when it is empty.
6. **Every move is checked for what agents gain.** Each route that moves gets a deliberate tier and permission area, an audience, a per-reader filter on private data, and a read class for its output (`outside` for text from outside sources), plus a line in the agents' awareness block. A fresh review checks agent exposure before the pull request opens.

## Amendments (2026-11-26, as A1 built them)

Each was decided with Security (t1j) on DOR-4978 and is enforced by code and a pinned test.

1. **Network modes, built.** The capability field is `wifi?: 'lowers-power' | 'person-held'` (it replaced `allowFromWifi`). A narrow list names each id with its one mode, and a census pins the set. A held, unproven Wi-Fi device may not give an agent work: it can't make or hand over an agent's to-do, change or answer an agent's promise, or replay queued canvas work.
2. **Writes that are network-reachable by design** stay hand routes until A5 decides whether a person-held audience may accept an API key. They sit on the allowlist in the category `network-reachable`, each linked to DOR-5267, and a census pins all of them. When `PATCH /api/agents/:id/permissions` moves, it maps to `lowers-power` for the lowering half only.
3. **Confirm-first has a declared bar:** `confirmFirst: { bar: 'account-owner' | 'front-door' }`. The bar is static and listed per id. For `front-door`, the asking and the confirming request each pass the front-door bar, and the confirm must come in the same way (ingress kind) as the hold. The sheet and the 428 carry names and constants only. Hold and confirm are audited with the id and bar, never the input. State read for the sheet reaches the handler only as an HMAC under a per-process key, and a change answers 412. A hold raised mid-write stays a hand route.
4. **A person's reads pass an area Blocked for agents.** This applies on a capability's own REST path only (never `/invoke`), to `observe` calls only, and skips the area permission only. These reads are audited as the person, grouped per person, device and capability every 10 minutes. The grouping key never reaches a handler.
5. **Request facts stay yes/no answers.** A handler sees only the pinned list of answers (owner, person, at this computer, held Wi-Fi owner, agent bar, front-door owner and elsewhere, and so on). An id, address, token or key never reaches it.
6. **One import port.** A capability imports `defineCapability`, its types and `CapabilityToolError` from `services/core/capabilities/capability-definition.ts` only. The composition root `core/self-description/dorkos-registry.ts` is exempt from the services import ratchet.
7. **Capability inputs are describable as JSON Schema**, with no transforms. The catalog and the API document render them, so a value is converted inside the handler.
8. **A new folder of capability definitions** (`services/core/*-doors/`) joins Security's path pattern in the same pull request that creates it. The release lead confirms its side of the computer wall.

## Consequences

### Positive

- The person-only rule lives in one place, so no path can skip it, and a reviewer checks one field instead of reading each handler.
- Handlers can make owner and person decisions without ever seeing a credential.
- Network reachability is declared and pinned, not implied by a route's position in the chain.

### Negative

- Moving a route takes more than moving code: each one needs an exposure decision and a review, so A1 moves in small batches.
- Two network modes and a confirm-first hold add surface fields the mount must enforce and test.

### Neutral

- Routes that need a facility the mount lacks (the person-held network mode, confirm-first) wait on the pending list until it exists, rather than moving with a weaker check.
