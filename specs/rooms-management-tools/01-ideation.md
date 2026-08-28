---
slug: rooms-management-tools
number: 260828-003023
created: 2026-08-28
status: ideation
---

# Let agents manage rooms — five verbs behind the product's first hard tool toggle

**Slug:** rooms-management-tools
**Author:** ideator-1611 (DOR-1611)
**Date:** 2026-08-28

---

## 1) Intent & Assumptions

**Task brief.** An agent can talk in a room but cannot arrange one. It cannot open a channel for a piece of work, cannot pull a colleague in, cannot take one out, cannot fix a title it knows is wrong, and cannot step out of a conversation it is done with. Every one of those is a thing a teammate does without asking. This adds five verbs — `create_room`, `add_room_members`, `remove_room_members`, `update_room`, `leave_room` — and puts them behind a per-agent switch that is **off by default and actually blocks the call**.

That last clause is the whole engineering problem. DorkOS has four tool-group toggles today and **not one of them blocks anything**. `packages/shared/src/mcp-tool-groups.ts:5-24` says so at length and ends: _"Nothing in this file is a security boundary, and no edit here can make one."_ ADR `260726-171347` is the accepted decision behind that sentence. So this feature is not "add a fifth toggle". It is the first real one, and the interesting work is making it a boundary without lying about the four beside it.

**Assumptions.**

- The operator grants the group per agent, deliberately, one agent at a time. Nothing grants it automatically, and no agent grants it to itself.
- An agent that holds the grant is trusted the way a colleague is trusted: bounded by mechanism, not by asking permission mid-turn. It is not trusted to be un-prompt-injectable.
- Every room these verbs can touch is one the agent is already a member of, or one it is creating. Membership stays the gate it already is (`.claude/rules/room-conduct.md`: _"Membership is the gate, not the tier"_).
- The install has one owner. Multi-person installs are `accounts-and-auth`'s problem and this feature does not widen anything for a second person.
- Room invariants stay in `RoomService`. The toggle stays in the capability layer. Neither is asked to do the other's job.

**Out of scope.**

- **`archive_room`, deliberately.** Archiving is not a roster edit; it is a lifecycle verb. It stops the room being triggered at all (`room-service.ts:1981` calls `abandonHolds`), it is the product's stand-in for delete (there is no delete), and on a bridged room it is a different function entirely (`archiveBridgedRoom`, `room-service.ts:1381`, operator-only). It also collides head-on with an open defect: `updateRoom` has no operator gate for `archived`, and closing that gate is blocked on DOR-608 because `createRoom`'s DM un-archive path runs through it (`room-service.ts:18-25`). Shipping an agent-callable archive on top of an ungated field, whose own gate is blocked, is how you ship two bugs at once. It gets its own item after DOR-608.
- Per-verb granularity. One group covers all five (settled).
- A second person gaining any of this. `requireSeedingAllowed` already refuses a non-owner human seating an agent (`room-service.ts:4098-4100`) and that stays.
- Community-backed rooms. The `CommunityAdapter` port has no vocabulary for these refusals — the three-way rule's own error already escapes it untranslated (ADR `260814-025326` consequences) — and nothing user-facing routes through it yet.
- Any change to the four existing soft toggles' behavior.

---

## 2) Pre-reading Log

- `AGENTS.md` — bounds are mechanisms; simplicity is an active pursuit; describe what happens for the user.
- `.claude/rules/room-conduct.md` — the load-bearing rule. Three sentences govern this work. _"An agent's hand in a room is four verbs, and every one of them goes through the service… never a second write path."_ _"Who is calling is resolved, never assumed… neither present means the surface could name nobody, and on a login-on install that is a refusal (`UNIDENTIFIED_CALLER`), never a fallback to the owner."_ And the three-way rule, stated as a property of the roster _"checked at every verb that can change one"_.
- `specs/room-participation/02-specification.md` §10.2 — the rooms capability domain's design, and the sentence this feature has to argue past: _"`EnabledToolGroupsSchema` (`mesh-schemas.ts:108-121`) gains **no** `rooms` key. A togglable rooms group reproduces the footgun exactly."_ Also §10.2's placement decision, which is the one to copy: _"the tier check lives inside `registry.invoke` (DOR-467), so every surface reaching the capability inherits it and there is no second enforcement path to write."_
- `decisions/260726-171347-tool-group-toggles-gate-context-not-access.md` — **the decision this feature amends.** Carries the precondition in §Decision: _"Any future change that gives these toggles real teeth must first move them to `operator-only` in `config-write-policy.ts`, or an agent can widen its own permissions by editing its own config. This is the trap ADR-0070 fell into."_ Its Follow-up proposes registration-time omission as "the shape to build"; §4.1 below explains why invoke-time is the right seam instead.
- `decisions/260814-025326-three-way-rule-for-agent-seeded-rooms.md` — the three-way rule, its four shape properties, and why it is compositional rather than provenance-based. Note two lines have gone stale: it cites spec §12.4 for _"there is no delete, and no Leave"_, and DOR-1233 has since added Leave (`specs/rooms/02-specification.md` §12.4, struck through in place).
- `contributing/agent-operator-surface.md` — §"Permission tiers are enforced" (`:105`) and §"Identity is the ceiling, never the switch" (`:131`). The second is the design's central tension and §4.1 resolves it.
- `packages/shared/src/mcp-tool-groups.ts` — the "documentation-shaping only" comment (`:5-24`), the three-drifting-copies history (`:26-52`), and the exclusion that decides §4.2: _"Registry-generated tools … are deliberately absent: the registry already owns their names, and restating them here would be a new copy of the thing this table exists to remove"_ (`:84-88`).
- `research/` — checked. No report covers tool gating as an access-control mechanism; the closest (`20260304_agent_tools_elevation.md`, `20260813_room-architecture-vs-buzz-qm.md`) predate DOR-519's correction. The authoritative record is the two ADRs, not `research/`. No new research needed.

---

## 3) Codebase Map

**The enforcement spine.**

- `apps/server/src/services/core/capabilities/registry.ts` — `invoke()` declared `:257`, implemented `:420-517`. The single funnel.
- `apps/server/src/services/core/capabilities/capability-definition.ts:78-165` — `CapabilityDefinition`, where a `toolGroup` field would be declared.
- `apps/server/src/services/core/capabilities/mcp-projection.ts:230-292` / `:313-328` — the shared MCP half **both** servers use.
- `apps/server/src/services/core/capabilities/tier-enforcement.ts` — the refusal vocabulary (`:315-337`), and `StandingGrantLookup` (`:358-378`), the lookup shape to copy.

**The two MCP surfaces, which is the claim the whole design rests on.**

| Surface             | Registration                                                   | Handler    | Converges at            |
| ------------------- | -------------------------------------------------------------- | ---------- | ----------------------- |
| In-session `dorkos` | `runtimes/claude-code/mcp-tools/capability-mcp-tools.ts:87-91` | `:101-107` | `mcp-projection.ts:247` |
| External `/mcp`     | `services/core/external-mcp/capability-mcp-tools.ts:43-62`     | `:59-60`   | `mcp-projection.ts:247` |

Both call `invokeCapabilityAsMcpResult`, which calls `registry.invoke` and nothing else. `capability.invoke(...)` appears at exactly two lines in the server, `registry.ts:504` and `:510`, both inside `invoke()`. Neither adapter has another execution path. **The single-choke-point claim is true.**

**The rooms domain.**

- `apps/server/src/services/rooms/room-capabilities.ts` — six verbs today (`rooms.post`, `rooms.react`, `rooms.read_history`, `rooms.search_history`, `rooms.list_member_rooms`, `rooms.search_member_rooms`; ids `:321`–`:562`, tool names `:349`–`:593`). The brief said eight; it is six. `callerAuthor()` at `:188-217` is the domain's four-branch caller resolution. `:57-65` is the "No toggle, deliberately" block.
- `apps/server/src/services/rooms/room-service.ts` — `requireOperator` `:3970-3973`; `createRoom` `:956`; `addMember` `:2018`; `removeMember` `:2151`; `updateRoom` `:1942`; `requireSeedingAllowed` `:4092-4107`; `requireOwnerWitnessesAgents` `:4141-4155`; `requireSystemRoomWritable` `:4002-4014`; `requireSystemRoomKeepsOwner` `:4039-4046`.
- `apps/server/src/services/rooms/room-store.ts:300-325` — `findDmByMemberSet`, the DM dedupe.

**The grant.**

- `packages/shared/src/mesh-schemas.ts:131-144` — `EnabledToolGroupsSchema`; embedded in `AgentManifestSchema` at `:421`; picked into `UpdateAgentRequestSchema` at `:658`.
- `packages/shared/src/manifest.ts:38-72` — `readManifest`, uncached `readFile` + Zod parse. **The only real source.** `packages/mesh/src/agent-registry.ts:538-540` states the SQLite cache does not carry the field and returns `{}`.
- `apps/server/src/services/core/operator/agent-updater.ts:235-242` — file-first write (ADR-0043). `:157-160` — the `account` refusal, the precedent for a field an agent may not write.

**Data flow, as it would run.** Agent calls `add_room_members` → SDK/HTTP → adapter → `invokeCapabilityAsMcpResult` → `registry.invoke` → parse input → **resolve caller's grant, refuse if absent** → tier gate (`act`, runs, audited) → handler → `RoomService.addMember` → three-way rule + system-room guards → roster write → SSE fan-out.

**Blast radius.** `registry.ts` (every capability passes through the new check), `capability-definition.ts` (one optional field), the rooms domain, `mesh-schemas.ts` + the manifest write path, both client Tools tabs, the capability conformance suite, and six documents that currently state "there is no hard filter anywhere".

---

## 4) Research

### 4.1 The enforcement seam, and the one thing that makes it hard

**Where it goes.** Between `registry.ts:476` and `:480` — after `parsed` exists and `invocationContext` is assembled, and **before** `enforceCapabilityTier`, so a refused call never mints an approval card for an action that was never going to run. One insertion point, roughly five lines, and both MCP servers plus the HTTP invoke route plus the CLI inherit it by construction.

Two carve-outs must be named rather than assumed away. `authorizeCapability` (`tier-enforcement.ts:1039`) is a second sanctioned door to the gate that never reaches `invoke`; its only production caller is `routes/marketplace.ts:304`, allowlisted at `__tests__/gate-bypass-scan.test.ts:172-178`. And the 47 hand-registered MCP tools have a parallel gate (`services/core/mcp-tool-gate.ts`) and never reach `invoke` at all. Neither touches rooms — but it follows that **the five verbs must be registry capabilities, not hand-registered tools**, or they land outside the choke point.

**The hard part is not where. It is which way the check fails.**

`contributing/agent-operator-surface.md:131` states, as settled doctrine, that the gate _"deliberately does **not** key on identity presence"_, because an agent with shell access can `env -u DORKOS_AGENT_TOKEN` and an identity-keyed gate would then wave it through. A per-agent grant is identity-keyed by construction. So the doctrine appears to forbid exactly this feature.

It does not, and the reason is polarity. The tier gate asks a **negative** question — "is this caller restricted?" — where absent identity reads as "not restricted" and fails **open**. A group grant asks a **positive** question — "does this caller hold the grant?" — where absent identity reads as "holds nothing" and fails **closed**. The invariant both must satisfy is the same one the doc states: _"dropping a credential can never widen what a caller reaches."_ Under a positive grant, dropping a credential strictly narrows. The doctrine's reasoning is preserved, not overridden.

So the rule, stated so it can be tested:

| Resolved caller                                | Outcome                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| Identified agent, grant `true`                 | Runs                                                        |
| Identified agent, grant `false` or absent      | **Refused**                                                 |
| Identity resolvable but the lookup **throws**  | **Refused**                                                 |
| Trusted caller (a person, via `trustedCaller`) | Runs — _whoever may decide an approval may act without one_ |
| Unidentified                                   | **Refused**                                                 |

Two consequences worth stating out loud. First, `createInSessionContextResolver` currently swallows lookup failures and returns `undefined`, on the documented ground that _"attribution is a side channel: never fail the agent's tool call"_ (`agent-token-env.ts:105`). That default is correct for attribution and wrong for a boundary, so the fail-closed direction has to be explicit at the check rather than inherited from the resolver. Second, `trustedCaller` is minted at only two production sites (`routes/config.ts`, `routes/marketplace.ts`), so a person running `dorkos call rooms.add_members` with no token is refused. That costs nothing real: room management for a person lives in the cockpit, which reaches the HTTP room routes where an unidentified caller already resolves to the owner (`routes/room-caller.ts:107-131`). The capability surface is the agent surface.

**There is already a precedent for exactly this fail-direction on exactly these tools.** `IDENTITY_SCOPED_TOOLS` (`interactive-handlers.ts:314-325`) holds all six rooms verbs — plus `relay_notify_user` and `memory_write`, which is what makes that set eight — and their auto-allow _"holds only while the SESSION HAS AN AGENT IDENTITY (DOR-1229…). The identity is what makes that sentence true, which is why losing it takes the auto-allow with it"_ (`:148-157`). Losing identity already narrows a rooms verb. The five new ones join that set, and the reasoning at `:174-184` is why: without identity, `callerAuthor` falls back to the install owner, whose `seesEveryRoom` short-circuits `canSee`.

**Reading the grant.** Copy `StandingGrantLookup` (`tier-enforcement.ts:358-378`) — a lookup injected at boot, keyed on `agentPath`, **read fresh on every call** because a captured value would be _"a stale answer to a question that has to be current"_. The source is `readManifest(agentPath)` (`manifest.ts:38-72`), not SQLite, because the DB cache does not carry the field (`agent-registry.ts:538-540`). `invoke` is already `async`, so one warm `readFile` per management call is fine — and these are rare verbs, not `post_to_room`. The one inversion to make deliberately: `StandingGrantLookup` treats a throwing lookup as "no permission" (`tier-enforcement.ts:707-715`), which is _also_ closed for a positive grant. Same direction, same reason.

**The refusal shape.** Add `tool_group_disabled` to `TierDeniedReason` (`tier-enforcement.ts:315-316`) with `approvable: false`. This buys the existing rendering for free — `403` on HTTP (`routes/capabilities-invoke.ts:120-124`) and a non-`isError` text payload on both MCP servers (`mcp-projection.ts:283-285`) — and it reuses `capability.denied` on the Activity feed, so the operator sees what the agent _tried_. The message names the remedy in the product's own voice, the way `OWNER_MUST_BE_PRESENT` does:

> Managing rooms is turned off for this agent. Ask the person who runs this install to turn on **Manage rooms** in the agent's Tools settings.

Putting it in `TierDeniedReason` rather than in a `RoomErrorCode` is the whole point: a `RoomErrorCode` would live in the handler, which is a second enforcement path and reachable only by rooms.

### 4.2 Group metadata for registry tools

`MCP_TOOL_GATE_GROUPS` cannot be the answer, and the file says why: _"Registry-generated tools … are deliberately absent: the registry already owns their names, and restating them here would be a new copy of the thing this table exists to remove"_ (`mcp-tool-groups.ts:84-88`). That table maps _hand-registered tool names_ to groups. Adding registry ids to it would re-create the exact drift DOR-499 deleted.

**Proposal: the capability declares its own group.** An optional `toolGroup?: CapabilityToolGroup` on `CapabilityDefinition`, following `inSessionCard?` (`capability-definition.ts:146`) — a declarative optional field the definition states and a seam elsewhere interprets, which its own TSDoc frames as _"the capability says WHAT belongs on screen and the projection decides whether there is a screen"_ (`:132-140`). Same shape, different consumer.

One declaration then serves all three readers, which is the DOR-499 lesson applied rather than restated:

- **Enforcement** reads it at `registry.ts:~478`.
- **UI** reads it from the live registry through `capabilities.list` — already one of only two capabilities carrying an `http` surface — so the Tools tab shows the real tool names and count with no static copy to drift.
- **Docs** derive from the same catalog.

`approvalDisplayFields` supplies the second half of the pattern: it is conformance-enforced for `destructive` capabilities (`capability-definition.ts:117-118`), so machinery already exists for "a capability of kind X must declare this field". The conformance suite gains the mirror: every capability in the rooms-management set declares the group, and the group is non-empty.

Note what this does **not** touch. `ToolDomainKey` stays the four soft keys; `TOOL_INVENTORY` (`features/settings/config/tool-inventory.ts:30-36`) stays derived from `toolNamesForDomain`. The hard group is a different kind of thing and is rendered as one.

### 4.3 Schema, config, and the name

**The name is `roomsManage`.** Domain-first, because that is the house convention twice over: the four existing keys are bare domain nouns (`tasks`, `relay`, `mesh`, `adapter`), and capability ids are `${domain}.${verb}` with _"the prefix must equal the domain name"_. `manageRooms` inverts that and sorts away from its own domain. `roomsManage` also reads, at a glance in the schema, as visibly **not** `rooms` — which matters, because room-participation §10.2 and `room-capabilities.ts:57-65` both forbid a `rooms` key by name, and a reader must be able to see that the prohibition is honored.

**Where it lives.** In `EnabledToolGroupsSchema` (`mesh-schemas.ts:131-144`), because settled decision 7 wants one Tools tab reading one place, and because ADR `260726-171347` itself contemplates teeth landing on these toggles. But three conditions are non-negotiable, and the first is a blocking dependency.

1. **The agent must not be able to write its own grant.** This is the ADR's stated precondition and the codebase already knows the seam is open. `config-write-policy.ts:519-533`, verbatim: _"the per-agent seam has no bar of its own: `PATCH /api/agents/current` validates the boundary and delegates to `updateAgentManifest`, which refuses `account` and nothing else, with no caller-identity check at all… Reproduced during review… Tracked as DOR-1506."_ And `UpdateAgentRequestSchema` picks `enabledToolGroups` (`mesh-schemas.ts:658`), so the field is on that wire today. **A hard filter an agent can rewrite for itself is not a filter.**

   The fix is small, and the precedent one file over is not merely stylistic — it is the same problem already solved with the same split. `agent-updater.ts` describes itself (`:150-156`) as _"the AGENT-REACHABLE write path — the `update_agent` MCP tool and the self-edit route both land here"_, and refuses `account` there while noting that _"The operator's own surface, `PATCH /api/mesh/agents/:id`, accepts the field and does not come through here."_ That asymmetry is exactly what a grant needs: refused on every path an agent can reach, writable on the one the cockpit uses (`routes/mesh.ts:491-520`, file-first per ADR-0043). Refuse a write touching `enabledToolGroups.roomsManage` in `agent-updater.ts` the same way.

   **Be honest about what that does not close.** It closes the sanctioned agent surfaces. It does not stop an agent with shell access from curling `PATCH /api/mesh/agents/:id` directly, because with login off a bare loopback request is indistinguishable from the cockpit's — the inherited `local-trust` residual that `contributing/agent-operator-surface.md` already documents for every operator-only effect, and whose stated remedy is turning login on. Say that in the ADR rather than letting a reader infer a guarantee that is not on offer, which is the phrasing `config-write-policy.ts` itself uses. DOR-1506 remains the honest fix for the seam as a whole.

2. **No global default, so there is no second grant path.** The four soft groups are tri-state (`undefined` = inherit a global `agentContext.*Tools`). `roomsManage` is not: `undefined` means **off**. Decision 5 says the owner grants per agent, and a global "all agents may manage rooms" switch is a wider, blunter grant nobody asked for. It also removes the `config-write-policy.ts` entry, the `agentContext` twin, and the inherit rung from the UI. Simpler in every direction.
3. **The schema must stop making one claim about five keys.** The TSDoc (`:111-130`) and the OpenAPI description (`:139-144`) both say _"Off means the agent is not told about the group, not that the tools are blocked."_ That stays true of four keys and becomes false of the fifth. Both need splitting, and so does `mcp-tool-groups.ts:5-24`'s _"There is no hard filter anywhere in this pipeline"_ — which is about that file's own table and should be narrowed to say so, not deleted.

### 4.4 Service authorization: one write path, two layers

`requireOperator(viewerAuthorId, what)` (`room-service.ts:3970-3973`) takes a bare author id and asks the injected `isOwnerAuthor`. Seven call sites, all in `room-service.ts`: `setFallbackSeat:1092`, `ensureSystemChannel:1103`, `archiveBridgedRoom:1387`, `updateRoom:1946` (conditional, only for the four turn-limit fields), `addMember:2020`, `updateMembership:2124`, `removeMember:2153`. Three sibling inline owner checks exist at `createBridgedRoom:1250`, `rebridge:1443`, and `room-repo-service.ts:146`.

**Do not relax `requireOperator`.** Four of those seven call sites must not gain an agent path under any circumstance — `setFallbackSeat` and `updateMembership` decide who answers what, which is arbitration by another name; `archiveBridgedRoom` and the turn-limit fields let an agent raise its own reply ceiling, which is precisely the self-widening this whole feature exists to prevent.

**Instead, follow `requireSeedingAllowed`.** That function (`room-service.ts:4092-4107`) already encodes the shape this needs: owner passes; an agent gets a narrow escape; a second person never does. `addMember` and `removeMember` gain a sibling — call it `requireRosterWriteAllowed(caller, room, roster, intent)` — that replaces the bare `requireOperator` at `:2020` and `:2153` and reads:

- owner → allow (unchanged);
- caller is an agent **and a member of this room** → allow, subject to the rules below;
- anyone else → `OPERATOR_ONLY`, unchanged.

The agent-caller rules, each with a reason:

- **An agent may never remove the owner.** Settled decision 4, and stronger than the existing guard. `requireOwnerWitnessesAgents` only refuses the owner's removal when two or more agents would remain (`:4141-4155`); for an agent caller the refusal is unconditional, because "the person is in the room" is the guarantee and an agent must not be able to spend it.
- **The three-way rule stays where it is.** It is already caller-agnostic and already runs on both verbs (`addMember:2051-2060`, `removeMember:2155-2163`). Nothing moves. But `requireOwnerWitnessesAgents`'s TSDoc at `:4118-4120` currently asserts _"both membership verbs are already `requireOperator`, so the caller here is always the owner. This refuses the owner herself"_ — that sentence becomes false and its `'remove'` branch needs re-reasoning in writing for a non-owner caller.
- **System-room guards stay.** `requireSystemRoomWritable` and `requireSystemRoomKeepsOwner` are field checks on `room.wellKnown`, not caller checks (`room-errors.ts:52-69` explains why), so they hold for an agent caller unchanged.
- **Bridged rooms keep refusing a second agent** (`addMember:2036-2046`).

The capability handler stays a thin caller of the same `RoomService` method — `.claude/rules/room-conduct.md` forbids a second write path, and `room-capabilities.ts` already models the pattern with `postFromTool` being _"`post` plus three things and minus nothing"_. **The toggle is checked above, in `registry.invoke`; the invariants are enforced below, in the service. Neither duplicates the other, and removing either one leaves the other still meaningful.**

`createRoom` needs no authorization change at all: `requireSeedingAllowed` already grants an agent the path (`:993-999`). Its verb is a wrapper.

### 4.5 DM dedupe: it already exists

Evidence first. `createRoom:1001-1015` calls `RoomStore.findDmByMemberSet` (`room-store.ts:300-325`), a `GROUP BY … HAVING` query pinning both roster size and membership, so it matches an **exact** set, order-independent, and re-opens an archived match rather than duplicating it. `useStartDirectMessage` (`use-create-room.ts:163-177`) relies on this and says so: _"Asking twice for the same people is safe."_ The route returns 201 created / 200 matched (`routes/rooms.ts:105-114`).

**So `create_room` gets find-or-create free, and the right answer is to say so in the tool description rather than build anything.** The description tells the agent that asking for a DM it already has returns that DM.

Two honest caveats. The dedupe is a query, not a constraint — there is no roster hash and no unique index (`packages/db/src/schema/rooms.ts:369-377` has only the channel-slug and well-known indexes) — so two concurrent creates with the same roster can both miss and both insert. This is a pre-existing property of the HTTP path and nothing has hit it; an agent that retries a failed call is a more plausible racer than a double-clicking human, so it is worth recording, not worth a table migration in v1. And the dedupe check sits **after** the seeding gate on purpose (`:1001-1003`): a refused caller gets the same 403 whether or not the room exists, so this cannot be used to probe for rooms. Keep that order.

### 4.6 `update_room`: title and topic, and nothing else

`PATCH /api/rooms/:id` (`routes/rooms.ts:169-176`) accepts exactly eight fields (`room-schemas.ts:1117-1136`): `title`, `topic`, `archived`, `deliverNotices`, and four turn-limit fields. `slug` is **not** patchable — it is derived from `title` by `renamedSlug` (`room-service.ts:4352-4371`), channel-only, refusing `INVALID_SLUG` / `SLUG_TAKEN`.

The tool exposes `title` and `topic`. The other six are excluded, each for its own reason: `archived` is the deferred lifecycle verb; `deliverNotices` is a bridged-room field living on `room_bridges`; the four turn-limit fields are operator-only at `:1946` and are the reply ceiling itself.

Renaming a channel still moves its slug, which is a real side effect an agent should be told about in the tool description rather than discover.

**System rooms.** `requireSystemRoomWritable` (`:4002-4014`) refuses `title` and `archived` on a `wellKnown` room for a non-owner — and deliberately **not** `topic`, on the reasoning at `:3990-3996` that _"A topic is a description, and describing a shared room is ordinary participation"_. So on `#team` an agent may set the topic and may not rename. That is the existing rule and the tool inherits it rather than restating it.

### 4.7 `leave_room`: `removeMember(self)` is not sufficient

Mechanically it is `removeMember(roomId, self, self)`, and the three-way rule permits it — _"Taking an AGENT out is never refused, so nothing is ever wedged."_ But three wrinkles say the verb needs its own guards.

1. **There is no last-member guard anywhere.** `RoomRoster.remove` (`room-roster.ts:203-207`) only checks that the member exists. A room can be emptied.
2. **Leaving a 1:1 DM is unrecoverable, and that rule lives only in the client.** `RoomRowMenuItems.tsx:131-141` explains it: re-opening a DM with the same member set _"mints a **SECOND** room rather than reopening this one — `findDmByMemberSet` needs an EXACT set match, and `{owner, agent}` matches nothing once the owner has left."_ The same is true in reverse: an agent that leaves its DM with the owner strands the conversation, and the owner's next DM opens a fresh empty room. **The server does not enforce this.**
3. **The fallback seat is not cleaned up on removal.** `rooms.fallback_seat_author_id` is deliberately not a foreign key (`packages/db/src/schema/rooms.ts:315-318`). An agent that leaves while holding the seat leaves a room where a message nobody addressed reaches nobody until the next reconcile.

**Proposal.** `leave_room` refuses when `kind !== 'channel'` — the same spelling `post_to_room` uses and the same house rule that _"an unknown kind never gets more reach than a DM"_ — refuses a `wellKnown` room, and refuses when the caller holds the fallback seat, naming the remedy. An agent leaves channels. It does not leave the conversations it was opened for. Separately, and regardless of this feature, the 1:1-DM guard belongs on the server rather than in a menu.

### 4.8 Tier: `act`, and why the alternative is not a real option

All five are `act`. `destructive` would raise an approval card, and `interactive-handlers.ts:302-305` measured what that costs in the case this feature lives in: _"`search_room_history` asked at 15s, the room said the agent was waiting at 75s, and the turn made no further progress until the interaction window auto-denied it ten minutes later. Eleven minutes to answer one question."_ A room triggers a turn **into the dark** — nobody is holding that session's stream — so a card raised there is a card nobody is positioned to answer.

What bounds these verbs instead is what bounds every other room write: the hard toggle, membership, the three-way rule, the system-room guards, and the cascade guard and turn budget downstream. The same file already states the domain's position: _"A card on every message an agent posts into its own room would be the over-tiering that teaches people to click through, with the writes bounded by mechanisms instead."_

### 4.9 Exposure

The four existing room verbs are `alwaysLoad` — in the turn-1 prompt — because _"a room turn is a person waiting in a shared channel, and DOR-1292 measured a whole turn lost to searching for one"_ (`tool-exposure.ts:78-83`). The five management verbs are **not** that case: they are deliberate, occasional, and never on the critical path of answering someone. They stay deferred behind `ToolSearch` with `searchHint`s, which keeps five more schemas out of every turn's prompt on every session.

---

## 5) Decisions

Settled by the operator or orchestrator before this document — recorded, not re-litigated.

| #   | Decision                  | Choice                                                                                                                        | Rationale                                                                                               |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| S1  | Scope                     | Five verbs; `archive_room` deferred                                                                                           | Archiving is a lifecycle verb, not a roster edit, and its own gate is blocked on DOR-608 (§1)           |
| S2  | Toggle strength           | A hard per-agent filter, at one choke point on `registry.invoke`                                                              | Operator decision 2026-08-28. Holds identically for both MCP servers because both route through it (§3) |
| S3  | Tier                      | All five `act`, never `destructive`                                                                                           | An approval card in an unattended room turn is unanswerable — eleven minutes, measured (§4.8)           |
| S4  | Policy with the toggle on | Create channels + DMs; add anyone; remove anyone except the owner; system rooms and the three-way rule unchanged              | The invariants already exist and are caller-agnostic (§4.4)                                             |
| S5  | Default                   | Off; granted per agent; one group for all five                                                                                | —                                                                                                       |
| S6  | Conversation verbs        | Stay untoggleable                                                                                                             | The no-mute rationale in `room-capabilities.ts:57-65` stands (§4.3)                                     |
| S7  | UI                        | The group appears in both Tools tabs, with copy saying plainly that this switch blocks calls — and not implying the others do | They do not, and the tab currently says so in general terms (§6)                                        |

Decided here, with reasons.

| #   | Decision             | Choice                                                                                                       | Rationale                                                                                                                |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| D1  | Fail direction       | Refuse on absent identity, absent grant, or a throwing lookup                                                | A positive grant fails closed, which preserves "dropping a credential can never widen" rather than breaking it (§4.1)    |
| D2  | Refusal shape        | `tool_group_disabled` on `TierDeniedReason`, `approvable: false`                                             | Inherits 403 / non-`isError` / `capability.denied` for free; a `RoomErrorCode` would be a second enforcement path (§4.1) |
| D3  | Grant lookup         | A boot-injected lookup keyed on `agentPath`, read fresh per call, sourced from the manifest file             | Copies `StandingGrantLookup`; SQLite does not carry the field (§4.1)                                                     |
| D4  | Group metadata       | An optional `toolGroup` on `CapabilityDefinition`; UI and docs read the live registry                        | `MCP_TOOL_GATE_GROUPS` deliberately excludes registry tools; a static copy is the DOR-499 defect (§4.2)                  |
| D5  | Key name             | `roomsManage`                                                                                                | Domain-first like every other key and every capability id; visibly not `rooms`, which §10.2 forbids (§4.3)               |
| D6  | Self-grant           | `agent-updater.ts` refuses a write touching `enabledToolGroups.roomsManage`, mirroring the `account` refusal | ADR `260726-171347`'s stated precondition; the seam is open and reproduced (§4.3)                                        |
| D7  | Global default       | None. `undefined` means off, not inherit                                                                     | A global "all agents" switch is a wider grant nobody asked for, and removes a second grant path (§4.3)                   |
| D8  | Global Tools tab     | The group appears with **no switch** — a row naming it and pointing at the per-agent setting                 | Honors S7 without inventing the global default D7 removes                                                                |
| D9  | Service seam         | `requireRosterWriteAllowed` beside `requireSeedingAllowed`; `requireOperator` unrelaxed                      | Four of its seven call sites must never gain an agent path (§4.4)                                                        |
| D10 | Owner removal        | An agent may never remove the owner, in any room shape                                                       | Stronger than `requireOwnerWitnessesAgents`; the person's membership is the guarantee (§4.4)                             |
| D11 | DM dedupe            | Use the existing service dedupe; describe it in the tool; build nothing                                      | `findDmByMemberSet` already does exactly this (§4.5)                                                                     |
| D12 | `update_room` fields | `title` and `topic` only                                                                                     | The other six are lifecycle, bridge-owned, or the reply ceiling itself (§4.6)                                            |
| D13 | `leave_room` scope   | Channels only; refuses system rooms and the fallback seat                                                    | Leaving a DM is unrecoverable and the server does not currently stop it (§6)                                             |
| D14 | Exposure             | Deferred behind `ToolSearch`, not `alwaysLoad`                                                               | These are not the turn a person is waiting on (§8)                                                                       |

---

## 6) Risks & Security

**Prompt injection into a roster edit.** Other members' text is untrusted input — `.claude/rules/room-conduct.md` is explicit — so an agent holding this grant can be talked into adding or removing somebody. Four things bound it, and it is worth being precise about which do real work. The **toggle** bounds it to agents the owner deliberately armed. **Membership** bounds it to rooms the agent is already in. The **three-way rule** means no edit can produce a room the owner is not in. **D10** means no edit can remove her. What is _not_ bounded: an armed agent in a channel can add another of the owner's agents to that channel, and that agent will then be triggered by traffic there. That is the actual residual risk, it is the same risk as the owner adding it by hand, and the honest mitigation is that the refusals and the successes both land on the Activity feed (`capability.denied` already exists; `act` invocations are audited at the registry choke point).

**The self-grant hole is the one that would make this theatre.** Restated because it is the difference between a boundary and a comment: today an agent can `PATCH /api/agents/current` with its own `enabledToolGroups` and no caller-identity check runs (`config-write-policy.ts:519-533`, DOR-1506). D6 closes it for this key. **This feature must not merge without it**, and the test that proves it should be written as a defect reproduction, not as a happy path.

**`create_room` multiplies the turn budget, and this is measured, not theorised.** `turn-budget.ts:30-35` is addressed to exactly this feature and should be read as a requirement:

> _"The per-room cap alone is not a spend bound… **Rooms are free.** A caller that can create rooms multiplies its budget by creating them: measured through the real mount, a cap of 2/room bought 16 turns across 8 channels. That is not a defect in the per-room cap — it does exactly what it says — it is the difference between bounding a room and bounding a wallet."_

Until now nothing an agent could reach created rooms freely, so the per-room cap was the operative bound. `create_room` changes that, and what survives it is the **global** hourly cap, which is not keyed by room and never evicted (`turn-budget.ts:44-46`, `:99-102`). Two things follow for SPECIFY: the global cap is now load-bearing in a way it was not before and its default should be re-examined against this verb, and a test should assert that N rooms do not buy N × the per-room allowance. This is the strongest single argument for the toggle being off by default.

**Cascade and etiquette.** Members are seeded by kind — a new channel seeds agent members at `engaged` (`room-roster.ts:77`, `seedResponseMode:361-365`), not `always`. An **agent-authored** post outside a channel triggers only the members it _names_ (ADR `260814-025326` §2), and in a channel an `engaged` member with no prior anchor is reached only by an explicit mention. So the handoff works the way it should: an agent mid-turn that creates a channel, adds a colleague and posts "@bo can you take the migration?" inherits its own live cascade through `activeTurnFor` (`room-service.ts:3161`) and triggers Bo at depth + 1.

The case worth pinning is the other one. A post made with **no turn in flight** is stamped at the cascade ceiling (`cascade-guard.ts:173-174`), so every target fails the depth rule and **the refusal is deliberately silent** (`room-trigger.ts:810-855`). An agent that creates a room from a scheduled or aside path and posts into it summons nobody and nothing says so. That is existing `post_to_room` behaviour rather than something these verbs introduce, but `create_room` makes it reachable in a sequence that _looks_ like it should start a conversation. Pin the whole sequence with one test — create, add, post, assert the turn count in both the mid-turn and no-turn cases — because a handoff that silently reaches nobody is the failure mode this domain has already paid for twice. Adding a member never retro-triggers anything: a member reads only above its `joinedSeq`.

**Tests that must exist, and the property each has to have.**

- **Conformance, derived from the registry.** The pattern to copy is the destructive-tier check in `capabilityConformance` (`packages/test-utils/src/capability-conformance.ts:519-560`), which drives every destructive capability through `registry.invoke` and requires a refusal — _"derived from the registry rather than from a hand-listed set of adapters"_, and a registry declaring none is itself a violation, so it cannot go vacuous. The analogue: every capability declaring a `toolGroup` is refused through `registry.invoke` when the grant is off.
- **First, put the rooms domain under that suite at all.** It is not there today. `capability-conformance.test.ts:197-203` composes the registry with `operatorDeps, marketplaceDeps, connectorDeps, mcpDeps` and **no `roomDeps`**, and `dorkos-registry.ts:62` gates the rooms domain on exactly that key — so the six existing rooms verbs are outside the shared gate. Adding `roomDeps` to that fixture is a prerequisite task, and it is the kind of gap that stays invisible until something depends on it.
- **Both servers, separately — and the home already exists.** The registry-level check covers adapters that do not exist yet, but per-adapter probes prove something it cannot: that each adapter _translates_ the refusal. `routes/__tests__/room-capabilities-unverified-agent.test.ts` already drives the real `createMcpRouter` + `createExternalMcpServer` over supertest with real JSON-RPC `tools/call` bodies, and its header says why it exists rather than living upstairs: _"the defect is in the WIRING: the registry-level tests … were all green while this was open."_ **Extend that file; do not start a new one.**
- **Discriminating, not decorative.** Red-before / green-after on the same test: flip the grant and assert the outcome _changes_. A check that cannot fail is worse than none.
- **The declaration snapshot.** `room-capabilities.test.ts:107-173` pins the exact ids, tool names, tiers, servers and carve-out state of the domain. The five verbs go there or it goes red — which is the suite working.
- **The bypass scan.** `__tests__/gate-bypass-scan.test.ts` pins which modules may reach a protected effect without the registry. Roster writes become such an effect and belong on that list — its own TSDoc warns the effect list is incomplete and _"cannot fail for an effect nobody added"_.

**Two existing tests encode the old premise and must be reasoned about, not just edited.** `claude-code-runtime.test.ts:1343-1374` forbids anything setting `allowedTools` — it **stays exactly as it is**, because the hard filter is not `allowedTools` and reaching for that option is the mistake ADR-0070 already paid for. The other is sharper: `destructive-actions-prose.test.ts:723-735` (`'no page promises control over which tools an agent can use'`) scans docs, blog **and `apps/site` copy** for any sentence claiming tool-access control, and fails on it — because _"a sentence promising control over tool access is the one a user acts on when they believe they have sandboxed an agent."_ That test is right today and becomes wrong for exactly one group. Its `TOOL_ACCESS_CLAIM` regex needs a carve-out narrow enough that the sentence stays forbidden everywhere except where it is now true, and the carve-out itself needs a test. This is the highest-risk edit in the feature: widen it carelessly and the product can start making the claim ADR-0070 made falsely.

**The documentation risk, which is real here.** A spread of documents, guides, TSDoc blocks and one test currently say some version of "there is no hard filter", and every one of them is correct today. Leaving them is worse than the feature is good: the next reader will either believe the docs and mis-review a change, or believe the code and stop trusting the docs. §8 lists the ones I found; it should be treated as the floor rather than the full set, and a grep for the claim is part of the work.

---

## 7) Open Questions

**None blocking.** Every ambiguity was resolved above with a stated reason rather than parked, per the brief.

Four are judgement calls the orchestrator may want to overturn at SPECIFY, flagged so they are easy to find rather than hidden in a table: **D7/D8** (no global default, so the global tab row has no switch — S7 says the group appears there, and this is my reading of what it should _do_ there); **D13** (`leave_room` restricted to channels, which is narrower than "self-removal" as literally worded in the brief); **D6's scope** (refusing the one nested key now, versus blocking on DOR-1506 closing the whole seam — I recommend the former plus an explicit note that the seam is still open); and whether the **global hourly turn cap's default** should move now that `create_room` makes rooms a thing an agent can mint (§6). I would leave the number alone in v1 and let the test that pins the multiplication tell us, rather than changing a shipped default on a prediction.

One correction to the brief, recorded so it does not propagate: there are **six** existing rooms capability verbs, not eight (`room-capabilities.ts:321-593`). The eight-member set is `IDENTITY_SCOPED_TOOLS`, which is those six plus `relay_notify_user` and `memory_write`.

**Follow-ups discovered, for the tracker rather than for this spec.** DOR-1506 (the per-agent manifest write seam) is the blocking one. DOR-608 (`updateRoom` has no operator gate) gates `archive_room`. Beyond those: `docs/guides/agents.mdx:92` states something false about approval prompts today; the 1:1-DM leave guard exists only in client menu logic; `findDmByMemberSet` dedupes by query rather than by constraint and is not atomic; `rooms.fallback_seat_author_id` is not cleaned up when a member is removed; `requireOwnerWitnessesAgents`'s TSDoc asserts a caller invariant that this feature falsifies; and the rooms domain sits outside the shared capability conformance suite.

---

## 8) Spec-update Map

| Artifact                                                                                      | Change                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **New ADR**                                                                                   | The first hard tool filter: the choke point, the fail-closed rule, and why a positive grant does not contradict "identity is the ceiling". Amends `260726-171347` rather than superseding it — that ADR stays exactly right about the four soft groups |
| `decisions/260726-171347-…md`                                                                 | Amendment: its precondition has been met for one key; its Follow-up (registration-time omission) is superseded by invoke-time enforcement, because registration-time cannot reach the stateless `/mcp` server and "not offered" is not "cannot call"   |
| `specs/room-participation/02-specification.md` §10.2                                          | Amend the "gains no `rooms` key" paragraph: the prohibition covers **conversation** verbs, and a management group under a different key with different semantics does not reproduce the mute footgun                                                   |
| `decisions/260814-025326-…md`                                                                 | Two stale lines: "there is no delete, and no Leave" (DOR-1233 added Leave); and the consequences list predates any agent-reachable roster write                                                                                                        |
| `.claude/rules/room-conduct.md`                                                               | "An agent's hand in a room is four verbs" → six, plus five management verbs behind a grant; add the fail-closed rule and D10                                                                                                                           |
| `contributing/agent-operator-surface.md`                                                      | §"Identity is the ceiling, never the switch" gains its companion: a positive per-agent grant, and why the polarity matters                                                                                                                             |
| `packages/shared/src/mcp-tool-groups.ts:5-24`                                                 | Narrow "there is no hard filter anywhere in this pipeline" to this table's own tools                                                                                                                                                                   |
| `packages/shared/src/mesh-schemas.ts:111-144`                                                 | TSDoc + OpenAPI description split: four keys shape documentation, one blocks calls                                                                                                                                                                     |
| `contributing/architecture.md:647`, `agent-operator-surface.md:119`                           | The DOR-519 narrative gains its sequel                                                                                                                                                                                                                 |
| `docs/guides/agents.mdx:92`                                                                   | New copy for the group — **and fix the existing error**: it claims a disabled group's tool "still" prompts for approval, which is false for `act`-tier tools                                                                                           |
| `apps/server/src/services/core/__tests__/destructive-actions-prose.test.ts:723-735`           | `TOOL_ACCESS_CLAIM` needs a carve-out narrow enough to keep the claim forbidden everywhere it is still false (§6)                                                                                                                                      |
| `apps/server/src/services/core/capabilities/__tests__/capability-conformance.test.ts:197-203` | Add `roomDeps`, so the rooms domain is under the shared conformance gate at all (§6)                                                                                                                                                                   |
| `apps/server/src/services/rooms/__tests__/room-capabilities.test.ts:107-173`                  | Declaration snapshot gains the five verbs                                                                                                                                                                                                              |
| `specs/manifest.json`                                                                         | Registered (this change)                                                                                                                                                                                                                               |

---

## 9) Next Step

**Proceed to SPECIFY.** The design is resolved end to end and the one genuine dependency is identified rather than discovered late.

Proposed phasing, two PRs, split so the risky half is reviewable alone:

**PR 1 — the boundary.** `toolGroup` on `CapabilityDefinition`; the check in `registry.invoke`; `tool_group_disabled`; the grant lookup and its fail-closed direction; the `roomsManage` key; the `agent-updater` write refusal (D6) with its defect-reproduction test; `roomDeps` into the conformance fixture; the registry-derived conformance assertion and the external-`/mcp` probe; the `TOOL_ACCESS_CLAIM` carve-out; the documentation corrections in §8. **Ships no new verbs** — the mechanism is proved against a fixture capability, which is what makes it reviewable without the rooms surface arguing for it.

**PR 2 — the verbs.** `requireRosterWriteAllowed` and the `addMember`/`removeMember` agent paths; the five capability definitions and the declaration snapshot; the `leave_room` guards; the create→add→post turn-count test and the room-multiplication budget test; both Tools tabs; user docs and a changelog fragment.

**Blocking dependency:** DOR-1506, or at minimum D6's narrower closure of it. Stated plainly because it is the difference between a boundary and a comment — a hard filter an agent can grant itself is not a hard filter.
