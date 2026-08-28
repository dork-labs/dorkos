---
id: 260828-123331
title: The first hard per-agent tool filter lives at registry.invoke, keyed on a grant only a person may write
status: accepted
created: 2026-08-28
spec: rooms-management-tools
superseded-by: null
amends: 260726-171347
---

# 260828-123331. The first hard per-agent tool filter lives at registry.invoke, keyed on a grant only a person may write

## Status

Accepted (DOR-1611).

## Context

DorkOS ships four per-agent tool-group toggles and **none of them blocks anything**.
Turning one off leaves its tools registered and callable; all it does is leave that
group's documentation out of the agent's context. ADR `260726-171347` is the accepted
decision behind that, and `packages/shared/src/mcp-tool-groups.ts` ends the point
bluntly: _"Nothing in this file is a security boundary, and no edit here can make one."_
ADR-0070 is why — it built per-agent filtering on the premise that the SDK's
`allowedTools` option narrows a session's tool set. It does not; it auto-approves. That
shipped as a switch which appeared to restrict and did not, for three months.

The rooms-management verbs (`create_room`, `add_room_members`, `remove_room_members`,
`update_room`, `leave_room` — spec `rooms-management-tools`) need a real switch: they
change who is in a shared conversation, so the default has to be off and off has to
mean refused. Building "just another toggle" would ship the ADR-0070 defect again.

Three constraints were already written down before this work started:

1. **The tier gate deliberately refuses to key on identity**
   (`contributing/agent-operator-surface.md`). Keying on identity PRESENCE hands an
   agent with shell access a bypass needing less capability than the honest path:
   `env -u DORKOS_AGENT_TOKEN dorkos call …`. A per-agent grant is identity-keyed by
   construction, so the polarity has to be argued rather than assumed.
2. **The grant was agent-writable.** `config-write-policy.ts` records that
   `PATCH /api/agents/current` → `updateAgentManifest` ran _"no caller-identity check at
   all"_, and that this was _"Reproduced during review"_ (DOR-1506). A filter the
   governed agent can rewrite for itself is not a filter.
3. **`MCP_TOOL_GATE_GROUPS` cannot carry this.** It maps hand-registered tool NAMES to
   groups and deliberately excludes registry capabilities, because _"the registry already
   owns their names"_. Adding capability ids there re-creates the three-way drift DOR-499
   deleted.

## Decision

Build the first tool group with teeth as a **positive per-agent grant, enforced at one
choke point inside `registry.invoke`, sourced from a manifest field only a person may
write.** Five parts.

1. **The capability declares its own group.** `CapabilityDefinition.toolGroup?:
CapabilityToolGroup` (one member today, `roomsManage`), following the `inSessionCard?`
   precedent — the definition states what it needs and a seam elsewhere decides what to do
   about it. One declaration, three readers, and the third is why `serializeCapability`
   emits the field: enforcement reads it at the choke point, and the cockpit and the docs
   projection both read it off the live catalog — so neither needs a static list of which
   tools sit behind which grant, which is the copy that would drift.

2. **Enforcement runs inside `registry.invoke`, before the tier gate.**
   `enforceToolGroupGrant` (`services/core/capabilities/tool-group-enforcement.ts`) is
   called in the existing `if (!supplied.trusted)` block, one step ahead of
   `enforceCapabilityTier`, so a call that was never going to run cannot mint an approval
   card on its way to being refused. One point is enough because both MCP servers converge
   on `invokeCapabilityAsMcpResult` → `registry.invoke`, and `capability.invoke(...)`
   appears at exactly two lines in the server, both inside `invoke()`. Two paths do NOT
   pass here — `authorizeCapability` and the 47 hand-registered MCP tools — so it follows
   that **a gated verb must be a registry capability, never a hand-registered tool**.

   A sibling function rather than a branch inside `enforceCapabilityTier`: that function is
   about tiers, and a group check hiding inside it would be a name that lies.

3. **It fails closed, and the polarity is the whole design.** Identified agent holding the
   grant runs; identified agent without it, a lookup that throws, and an unidentified
   caller are all refused. A trusted caller runs, on the standing rule that whoever may
   decide an approval may act without one.

   This does not contradict "identity is the ceiling, never the switch". The tier gate asks
   a NEGATIVE question — "is this caller restricted?" — where absent identity reads as "not
   restricted" and fails OPEN, which is exactly why it must not key on identity. A grant
   asks a POSITIVE question — "does this caller hold it?" — where absent identity holds
   nothing and fails CLOSED. Both satisfy the invariant the doctrine protects: dropping a
   credential can never widen what a caller reaches. Under a positive grant, dropping one
   strictly narrows.

4. **The refusal extends the existing union rather than inventing one.**
   `tool_group_disabled` joins `TierDeniedReason`, carrying the unchanged
   `TierDeniedPayload` with **`approvable: false`**. Three behaviours come free and
   unchanged: HTTP `403`, a non-`isError` MCP text payload on both servers, and a
   `capability.denied` Activity event, so the operator sees what the agent tried.
   `approvable: false` is load-bearing — it tells the model no approval can ever unlock
   this, so it does not loop asking for one in a place it cannot reach.

5. **The grant is read fresh from the manifest, and the agent cannot write it.**
   `ToolGroupGrantLookup` is injected at boot and read on every gated call, mirroring
   `StandingGrantLookup`: a person may revoke between two invocations, so "turning it off
   stops the very next call" has to be a property of the code. The source is
   `readManifest(agentPath)`, never the SQLite cache — `agent-registry.ts` has no column
   for `enabledToolGroups` and returns `{}` for every agent, so the cache would report
   every agent as ungranted AND silently ignore a real grant. Not cached: one warm
   `readFile` against a stale grant is not a close trade.

   `updateAgentManifest` — the agent-reachable write path behind `PATCH
/api/agents/current` and the `update_agent` MCP tool — **refuses any patch naming
   `enabledToolGroups.roomsManage`**, present at all, whatever its value, before the schema
   parse. Refused rather than stripped, on the precedent of the `account` guard beside it:
   an agent told nothing would report the change as done. The operator's `PATCH
/api/mesh/agents/:id` writes the field and does not come through there.

`undefined` means OFF for this key, not "inherit": there is no global twin, because a
second and weaker path to the same grant would be a way around the first. The four
documentation keys keep their inherit semantics and their `ToolDomainKey` union, both
untouched.

We rejected `allowedTools` (ADR-0070's post-mortem is the reason this is invoke-time), a
registration-time omission on the MCP servers (the external `/mcp` server is stateless, so
registration-time cannot reach it), and a `RoomErrorCode` in the rooms handler (a second
enforcement path, reachable only by rooms, inheriting none of the rendering above).

## Consequences

### Positive

- A tool group can now genuinely refuse, at one place, provably identically on the
  in-session and external `/mcp` servers — proved over the real routers rather than at
  `registry.invoke` alone, because the defect class that shipped twice was in the wiring.
- Dropping `X-DorkOS-Agent` narrows rather than widens, so the cheapest attack there is
  buys nothing.
- Every refusal is one line in the Activity feed, so an attempt an agent made and did not
  get is visible even though it did nothing.
- The conformance suite derives its subjects from the registry, so a capability that
  declares a group tomorrow is covered the day it declares one — no list to add it to.
- Nothing about the four soft toggles changed. ADR `260726-171347` stays exactly right
  about them; this ADR amends it by recording that one key beside them now behaves
  differently, and that its Follow-up on registration-time omission is answered instead by
  invoke-time enforcement.

### Negative

- **Two kinds of key now live in one object.** `EnabledToolGroups` holds four keys that
  shape documentation and one that blocks, with different semantics for `undefined`. Three
  comment sites were split to say so; a reader who skims will still get it wrong, and a
  fifth documentation key added carelessly beside `roomsManage` would inherit the wrong
  mental model.
- **A capability declaring a group is agent-only by construction.** `trustedCaller` is
  called at four production sites — `routes/extensions-approval.ts`, `routes/config.ts`,
  `routes/marketplace.ts` and `routes/shapes.ts` — and three of them use it as a bare
  predicate; only `routes/marketplace.ts` keeps the marker and carries it onward. The
  operative fact is narrower than the count and does not depend on it: **neither of the two
  `capability.invoke(...)` call sites is ever reached with a trusted marker from the invoke
  route**, which deliberately mints none. So a person cannot reach a gated capability
  through `dorkos call` at all. Correct for rooms — a person manages rooms in the app, over
  the HTTP room routes — but it is a real property of the mechanism, not of this one
  feature, and a fifth call site that started FORWARDING its marker into `invoke` would
  change it.
- **The self-grant closure is narrow.** It covers one field on the sanctioned agent
  surfaces. It does not stop an agent with shell access from curling `PATCH
/api/mesh/agents/:id` directly, because with login off a bare loopback request is
  indistinguishable from the app's own — the inherited `local-trust` residual, whose stated
  remedy is turning login on. The general caller-identity policy for the manifest remains
  DOR-1506.
- **The refusal is whole, not partial.** A patch that names `roomsManage` is refused
  entirely, so a client that reads the stored `enabledToolGroups` object and spreads it
  into an unrelated toggle is refused too. Any surface editing tool groups for an agent
  that holds the grant must use the operator's route.
- One extra `readFile` + Zod parse per invocation of a group-declaring capability. Bounded:
  only such capabilities pay it, and none is on the room-turn hot path.
