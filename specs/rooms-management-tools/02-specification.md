---
slug: rooms-management-tools
number: 260828-003023
created: 2026-08-27
status: specified
---

# Let agents manage rooms — five verbs behind the product's first hard tool toggle

**Status:** Approved
**Author:** ideator-1611 (DOR-1611)
**Date:** 2026-08-27

## Overview

Five new capabilities in the existing `rooms` domain — `create_room`, `add_room_members`, `remove_room_members`, `update_room`, `leave_room` — let an agent arrange the conversations it works in, not just talk in them. They sit behind a per-agent switch that is **off by default and actually refuses the call**.

That second half is the engineering content. DorkOS ships four tool-group toggles and none of them blocks anything: `packages/shared/src/mcp-tool-groups.ts:5-24` says so and ends _"Nothing in this file is a security boundary, and no edit here can make one."_ ADR `260726-171347` is the accepted decision behind that sentence. This spec builds the first toggle with teeth, at one choke point, without weakening the four beside it or lying about them.

## Background / Problem Statement

An agent in a room can post, react, read and search (`room-capabilities.ts:321-593`, six verbs). It cannot open a channel for a piece of work, pull a colleague in, take one out, fix a wrong title, or step out of a finished conversation. Every one of those is ordinary teammate behaviour, and today each needs the person.

Three constraints make this non-trivial, and all three are already written down:

1. **The obvious mechanism does not exist.** Tool-group toggles shape documentation only. Building "just another toggle" would ship a switch that appears to restrict and does not — the exact defect ADR-0070 shipped for three months.
2. **The gate deliberately refuses to key on identity.** `contributing/agent-operator-surface.md:131` — keying on identity presence lets an agent with shell access drop `DORKOS_AGENT_TOKEN` and walk through. A per-agent grant is identity-keyed by construction, so the polarity has to be argued rather than assumed.
3. **The grant is currently agent-writable.** `config-write-policy.ts:519-533` records that `PATCH /api/agents/current` → `updateAgentManifest` runs _"no caller-identity check at all"_ and that this was _"Reproduced during review"_ (DOR-1506). A hard filter an agent can rewrite for itself is not one.

## Goals

- Five agent-callable room-management verbs, tier `act`, each a thin caller of an existing `RoomService` method.
- A per-agent grant that **refuses** — at one choke point, provably identical on the in-session and external `/mcp` servers.
- The grant is not writable by the agent it governs, through any agent-reachable path.
- Room invariants stay in `RoomService`; the toggle stays in the capability layer; neither duplicates the other.
- Copy — UI, docs, tool descriptions — that says truthfully which switch blocks and which do not.

## Non-Goals

- **`archive_room`.** A lifecycle verb, not a roster edit, and `updateRoom.archived` is ungated for ordinary rooms because closing it breaks `createRoom`'s DM un-archive path. Blocked on **DOR-608**; orchestrator files separately.
- **Moving the global hourly turn-cap default.** `create_room` makes rooms mintable and `turn-budget.ts:30-35` measured that _"rooms are free"_ — a 2/room cap bought 16 turns across 8 channels. Real, and **deferred out of this programme** (orchestrator, 2026-08-27); orchestrator files it. This spec ships a test that _measures_ the multiplication (§Testing) without changing the number.
- **`findDmByMemberSet` atomicity.** Dedupe is a query, not a constraint, so concurrent creates can both insert. Pre-existing on the HTTP path; orchestrator files separately.
- **The full DOR-1506 caller-identity policy for the whole manifest.** This spec closes the seam for the grant-bearing field only (§D6). The general policy stays DOR-1506's remit.
- Per-verb granularity; a global default for the hard group; any new capability for a second person; community-backed rooms.

## Technical Dependencies

None new. Zod (already), the existing capability registry, `RoomService`, and the agent manifest. No new packages, no migration, no new table, no new column.

## Detailed Design

### D1. The enforcement point

**Where.** Inside `registry.invoke` (`registry.ts:420-517`), in the existing `if (!supplied.trusted)` block at `:480`, immediately **before** `enforceCapabilityTier` — so a refused call never mints an approval card for an action that was never going to run.

```ts
// registry.ts, inside `if (!supplied.trusted) {`
const grant = enforceToolGroupGrant({
  action: capability, // carries `toolGroup`
  identity: supplied.identity, // may be undefined
  lookup: toolGroupGrantLookup,
});
if (grant.outcome !== 'allowed') throw new CapabilityGateRefusal(grant.payload);
```

A sibling function rather than a branch inside `enforceCapabilityTier`, because that function is about tiers and a group check hiding in it would be a name that lies.

**Why one point is enough, verified rather than assumed.** Both MCP servers converge on one line: the in-session server (`claude-code/mcp-tools/capability-mcp-tools.ts:101-107`) and the external `/mcp` server (`core/external-mcp/capability-mcp-tools.ts:59-60`) both call `invokeCapabilityAsMcpResult` (`mcp-projection.ts:247`), which calls `registry.invoke` and nothing else. `capability.invoke(...)` appears at exactly two lines in the server, `registry.ts:504` and `:510`, both inside `invoke()`.

**Two paths that do NOT pass here, and the constraint each imposes.** `authorizeCapability` (`tier-enforcement.ts:1039`, sole caller `routes/marketplace.ts:304`) and the 47 hand-registered MCP tools (`services/core/mcp-tool-gate.ts`). Neither touches rooms — but it follows that **the five verbs must be registry capabilities, never hand-registered tools**, or they land outside the choke point.

**The fail direction, which is the whole design.**

| Resolved caller                           | Outcome                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| Identified agent, grant `true`            | Runs                                                        |
| Identified agent, grant `false` or absent | **Refused**                                                 |
| Identity present but the lookup throws    | **Refused**                                                 |
| Trusted caller (`trustedCaller`)          | Runs — _whoever may decide an approval may act without one_ |
| Unidentified                              | **Refused**                                                 |

**Why this does not contradict "identity is the ceiling, never the switch".** The tier gate asks a _negative_ question — "is this caller restricted?" — where absent identity reads as "not restricted" and fails **open**; that is why it must not key on identity. A group grant asks a _positive_ question — "does this caller hold the grant?" — where absent identity reads as "holds nothing" and fails **closed**. Both satisfy the invariant the doctrine actually protects: _dropping a credential can never widen what a caller reaches._ Under a positive grant, dropping a credential strictly narrows.

**A property that falls out, and should be stated rather than discovered.** `trustedCaller` is minted at only two production sites (`routes/config.ts`, `routes/marketplace.ts`) and the invoke route deliberately never mints one. So **these five capabilities are agent-only by construction**: a person cannot reach them through `dorkos call` or the invoke route at all. That is correct and costs nothing — a person manages rooms in the cockpit, which uses the HTTP room routes. It also means `callerAuthor` (`room-capabilities.ts:188-217`) always takes its `context.identity` branch for these five, so the login-off owner fallback at `:216` is unreachable here.

**In-session identity cannot be shed.** It is derived from the session's working directory, not from a presented token (`contributing/agent-operator-surface.md:151`), so an in-session agent cannot become anonymous by unsetting an env var. On the external `/mcp` surface, dropping `X-DorkOS-Agent` yields "unidentified", which this table refuses.

**Precedent.** `IDENTITY_SCOPED_TOOLS` (`interactive-handlers.ts:314-325`) already makes all six rooms verbs' auto-allow contingent on holding an identity — _"losing it takes the auto-allow with it"_ (`:148-157`). The five new verbs join that set.

### D2. The refusal shape

Extend the existing union rather than inventing a parallel one, so all downstream rendering is inherited:

```ts
// tier-enforcement.ts:315-316
export type TierDeniedReason =
  | 'tier_ceiling'
  | 'operator_denied'
  | 'enforcement_unavailable'
  | 'input_not_bindable'
  | 'tool_group_disabled'; // NEW
```

The payload is the existing `TierDeniedPayload` (`:319-337`) unchanged in shape: `status: 'denied'`, `capabilityId`, `capabilityTitle`, `tier`, `reason: 'tool_group_disabled'`, **`approvable: false`**, `message`. `approvable: false` is load-bearing — it tells the model no approval can ever unlock this, so it does not loop asking.

`message`, in the product's voice, naming the remedy the way `OWNER_MUST_BE_PRESENT` does:

> `Managing rooms is turned off for this agent. Ask the person who runs this install to turn on "Manage rooms" in this agent's Tools settings.`

**What this buys for free**, and the reason a `RoomErrorCode` would be wrong here: `CapabilityGateRefusal` already maps to `403` on HTTP (`routes/capabilities-invoke.ts:120-124`), to a non-`isError` text payload on both MCP servers (`mcp-projection.ts:283-285`), and to a `capability.denied` Activity event — so the operator sees what the agent _tried_. A `RoomErrorCode` would live in the handler, which is a second enforcement path and reachable only by rooms.

The `TierDeniedReason` TSDoc bullet list gains a matching entry; it is the documented vocabulary and an undocumented member is drift.

### D3. The grant lookup

Mirror `StandingGrantLookup` (`tier-enforcement.ts:358-378`), whose TSDoc states the rule this must follow: both halves _"have to be read FRESH on every gated call… a value captured at boot would be a stale answer to a question that has to be current."_

```ts
/**
 * Whether one agent holds one capability tool group.
 *
 * An interface, injected at boot, read FRESH on every gated call: a person may
 * revoke the grant between two invocations, and a captured value would answer a
 * question that has to be current. This is what makes "turning the switch off
 * stops the very next call" a property of the code rather than a promise.
 */
export interface ToolGroupGrantLookup {
  /**
   * Whether this agent holds this group.
   *
   * Returns `false` for an agent with no manifest, no `enabledToolGroups`, or the
   * key absent. Throwing is treated as `false` by the caller: a grant that cannot
   * be read is a grant that is not held.
   */
  holds: (agentPath: string, group: CapabilityToolGroup) => Promise<boolean>;
}
```

**Source of truth is the manifest file**, `readManifest(agentPath)` (`packages/shared/src/manifest.ts:38-72`), **not** SQLite: `packages/mesh/src/agent-registry.ts:538-540` states the DB cache does not carry the field and returns `{}`, so reading the cache would report every agent as ungranted _and_ would silently ignore a real grant.

**No caching.** `invoke` is already `async`; these are deliberate, occasional verbs, not `post_to_room`. One warm `readFile` per management call is the correct trade against a stale grant.

**Fail closed on throw**, matching `StandingGrantLookup`'s own handling (`tier-enforcement.ts:707-715`), which treats a throwing lookup as "no permission".

### D4. `CapabilityDefinition.toolGroup`

`MCP_TOOL_GATE_GROUPS` cannot carry this: it maps _hand-registered tool names_ to groups, and registry tools are deliberately excluded — _"the registry already owns their names, and restating them here would be a new copy of the thing this table exists to remove"_ (`mcp-tool-groups.ts:84-88`). Adding registry ids there re-creates the drift DOR-499 deleted.

So the capability declares its own group, following the `inSessionCard?` pattern (`capability-definition.ts:146`) — a declarative optional field the definition states and a seam elsewhere interprets:

```ts
/** The tool groups a capability may belong to. One member today. */
export type CapabilityToolGroup = 'roomsManage';

// added to CapabilityDefinition:
/**
 * The per-agent grant this capability requires, if any.
 *
 * Declaring it makes the capability HARD-GATED: `registry.invoke` refuses the
 * call unless the resolved caller is an identified agent holding the grant.
 * Undeclared (the default, and every capability today) means ungated — the tier
 * gate is the only gate.
 *
 * Unlike the four `enabledToolGroups` keys in `mcp-tool-groups.ts`, which shape
 * documentation only (ADR 260726-171347), this field is a real boundary. Do not
 * add one without reading that ADR's condition on agent-writable grants.
 */
toolGroup?: CapabilityToolGroup;
```

**One declaration, three readers.** Enforcement reads it at `registry.ts:~478`; the client reads it from the live catalog via `capabilities.list` (already one of only two `http`-surface capabilities), so the Tools tab shows real tool names with no static copy to drift; docs derive from the same catalog.

**`ToolDomainKey` is untouched** and stays the four soft keys. The global settings tab hardcodes a `Record<ToolDomainKey, number>` over exactly those four (`features/settings/ui/ToolsTab.tsx:76-86`); widening that union would ripple through machinery whose semantics do not apply here.

### D5. The grant key

```ts
// packages/shared/src/mesh-schemas.ts, inside EnabledToolGroupsSchema
roomsManage: z.boolean().optional(),
```

**Name.** `roomsManage`, domain-first — matching the four bare-noun keys (`tasks`, `relay`, `mesh`, `adapter`) and the `${domain}.${verb}` id convention where _"the prefix must equal the domain name"_. It is also visibly **not** `rooms`, which `room-participation` §10.2 and `room-capabilities.ts:57-65` forbid by name, so a reader can see the prohibition is honoured.

**Semantics differ from its four siblings and the schema must say so.** `undefined` means **off**, not "inherit" — there is no global twin (orchestrator-approved). This removes the `agentContext.*Tools` key, the `config-write-policy.ts` verdict, and the tri-state rung from the UI, leaving exactly one grant path.

**Three comment sites must split their claim**, because one object now holds two kinds of key:

- `mesh-schemas.ts:111-130` TSDoc — currently _"It does not remove them… This steers an agent rather than restricting it (DOR-519)."_
- `mesh-schemas.ts:139-144` OpenAPI description — currently _"Off means the agent is not told about the group, not that the tools are blocked."_
- `mcp-tool-groups.ts:5-24` — narrow _"There is no hard filter anywhere in this pipeline"_ to that file's own table, which stays true.

### D6. Closing the self-grant seam (narrow, per orchestrator ruling)

`UpdateAgentRequestSchema` picks `enabledToolGroups` (`mesh-schemas.ts:658`), so the field is on the agent-reachable wire today and nothing checks who is calling.

**The fix has an exact structural precedent one file over.** `agent-updater.ts` describes itself (`:150-156`) as _"the AGENT-REACHABLE write path — the `update_agent` MCP tool and the self-edit route both land here"_, refuses `account` there (`:157-160`), and notes _"The operator's own surface, `PATCH /api/mesh/agents/:id`, accepts the field and does not come through here."_ That asymmetry is exactly what a grant needs.

**Specified behaviour.** In `updateAgentManifest`, before any write: if the incoming body's `enabledToolGroups` contains the key `roomsManage` — present at all, whatever its value, including `undefined` — refuse with `AgentUpdateError('OPERATOR_ONLY', …)`:

> `Whether an agent may manage rooms is set by a person, in the agent's Tools settings.`

**Refused, not stripped**, for the reason `:157-160` already gives about `account`: _"an agent told nothing would report the change as done."_ A partial write is not offered — the whole patch is refused, matching `operator.config_patch`'s all-or-nothing posture.

The operator's path (`routes/mesh.ts:491-520`, file-first per ADR-0043) is untouched and remains the only way to set it.

**Scope boundary, stated so it is not over-read.** This closes the sanctioned agent surfaces for this one field. It does **not** stop an agent with shell access from curling `PATCH /api/mesh/agents/:id` directly, because with login off a bare loopback request is indistinguishable from the cockpit's — the inherited `local-trust` residual documented in `contributing/agent-operator-surface.md`, whose stated remedy is turning login on. The general caller-identity policy for the manifest remains **DOR-1506**, referenced and not absorbed.

> **Resolved 2026-09-02 (DOR-1506).** The general policy shipped: `agent-write-policy.ts` classifies every leaf of the agent-reachable manifest wire `operator-only` / `agent-writable` / `tighten-only`, `updateAgentManifest` enforces it in one place, and a drift guard fails the build when a new field arrives unclassified. The narrow guard described above is now one row of that table, and the four documentation keys beside `roomsManage` are refused too. The `local-trust` residual in this paragraph is unchanged and still accurate.

### D7. `requireRosterWriteAllowed`

`requireOperator` (`room-service.ts:3970-3973`) is **not relaxed**. Four of its seven call sites must never gain an agent path: `setFallbackSeat:1092` and `updateMembership:2124` decide who answers what, which is arbitration by another name; `archiveBridgedRoom:1387` and the turn-limit branch of `updateRoom:1946` are spend authority.

A sibling replaces the bare `requireOperator` at `addMember:2020` and `removeMember:2153`, modelled on `requireSeedingAllowed:4092-4107`, which already encodes "an agent may, a second person may not":

> **Amended 2026-08-29 (orchestrator ruling, on the PR review).** It replaces it on a SIBLING METHOD, not on `addMember`/`removeMember` themselves. Replacing it in place — which is what shipped first — widened the two HTTP roster routes with it, because `POST /api/rooms/:id/members` and `DELETE /api/rooms/:id/members/:authorId` resolve their caller from `X-DorkOS-Agent` and never reach `registry.invoke`, where the `roomsManage` grant lives. That turned the grant into something a direct request could step around, and it was a regression rather than an inherited gap: those two methods had been unconditionally operator-only, so they refused every agent token before this work.
>
> **An agent's roster surface is the capability verbs, full stop. The grant does not unlock HTTP.** `addMember`/`removeMember` keep `requireOperator` and remain what the routes, the `LocalCommunityAdapter` and the team-room hook call; `addMemberFromTool`/`removeMemberFromTool` carry `requireRosterWriteAllowed` and the leaving guards, and nothing but the rooms capability domain calls them. Two methods rather than a parameter, so a surface added tomorrow gets the operator-only one by default — the same shape `postFromTool` already uses, and fail-closed in the direction that matters.
>
> The four `requireOperator` call sites named above are still not relaxed; this adds a fifth and sixth guarded entry point rather than moving any of them.

```ts
private requireRosterWriteAllowed(
  room: Room,
  caller: AuthorRecord,
  what: string
): void
```

**Every refusal, enumerated.** Guards run in this order; the first match throws.

| #   | Condition                                            | Code                                    | Message                                                                                 |
| --- | ---------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Caller is the owner                                  | —                                       | allowed, unchanged                                                                      |
| 2   | Caller is not an agent                               | `OPERATOR_ONLY`                         | `Only you can change who is in a room` (today's text)                                   |
| 3   | Caller is an agent that is not a member of this room | `ROOM_NOT_FOUND`                        | via `requireVisibleRoom`, already first in both verbs — a room id is never a capability |
| 4   | Agent caller, target is the owner (remove)           | `OPERATOR_ONLY`                         | `Only you can take yourself out of a room`                                              |
| 5   | Target is the owner and room is `wellKnown`          | `SYSTEM_ROOM`                           | existing `requireSystemRoomKeepsOwner:4039-4046`                                        |
| 6   | Resulting roster holds ≥2 agents without the owner   | `OWNER_MUST_BE_PRESENT`                 | existing `requireOwnerWitnessesAgents:4141-4155`                                        |
| 7   | Bridged room gaining a second agent                  | existing guard at `addMember:2036-2046` | unchanged                                                                               |

Row 4 is **stronger than the three-way rule** and deliberately so: `requireOwnerWitnessesAgents` refuses the owner's removal only once two agents would remain, whereas an agent may never remove the owner in any room shape (operator-settled). The person's membership is the guarantee; an agent must not be able to spend it.

Rows 5–7 are existing guards, unchanged, and are **field checks rather than caller checks** (`room-errors.ts:52-69`), so they hold for an agent caller with no edit.

**`requireOwnerWitnessesAgents`'s TSDoc becomes false and is corrected here** (absorbed scope item c). It currently asserts _"both membership verbs are already `requireOperator`, so the caller here is always the owner"_ (`:4118-4120`); after this change the caller may be an agent, and its `'remove'` branch wording — _"take one of them out before you leave it"_ — addresses the owner. The guard's behaviour is right; only its stated premise and one message need re-reasoning.

**`createRoom` needs no authorization change.** `requireSeedingAllowed:4092-4107` already grants an agent the path; its verb is a wrapper.

### D8. The five verbs

All tier `act`, all `servers: ['in-session', 'external']`, all `toolGroup: 'roomsManage'`, all thin callers of an existing `RoomService` method wrapped in the domain's existing `answering()` + `callerAuthor()` helpers (`room-capabilities.ts:188-217`). **No new write path and no new read predicate** (`.claude/rules/room-conduct.md`).

| Capability id          | Tool name             | Service call              |
| ---------------------- | --------------------- | ------------------------- |
| `rooms.create`         | `create_room`         | `createRoom`              |
| `rooms.add_members`    | `add_room_members`    | `addMember` per member    |
| `rooms.remove_members` | `remove_room_members` | `removeMember` per member |
| `rooms.update`         | `update_room`         | `updateRoom`              |
| `rooms.leave`          | `leave_room`          | `removeMember(self)`      |

**Inputs**, as Zod, deliberately narrower than the HTTP schemas they wrap.

> **Amended 2026-08-29 (build + adversarial review).** The shipped verbs take ONE
> member list per verb — `members: string[]` — where each entry is the `@handle`
> a room lookup reports, **or that member's author id**, resolved in that order by
> `RoomService.findAuthorByHandle`. The two-list shape below (`agentPaths` +
> `memberAuthorIds`) is not what shipped.
>
> A handle is primary because it is the name a person types and the name
> `get_room` leads with. The id fallback is not a convenience: `mintHandle`
> returns `null` for the install's own human (the only string it could derive from
> is the placeholder `'You'`; DOR-979 is the surface that will ask her for one), so
> on a default install **the owner has no handle at all** — and by the three-way
> rule every room an agent may open with a colleague is one she has to be in.
> Without the fallback `create_room` with a colleague answered `OPERATOR_ONLY`
> and naming her by the id the roster had just handed over answered
> `MEMBER_NOT_FOUND`: a dead end with prose that sent the model in a loop. The
> same gap catches any agent whose name spells nothing legal. Reviewer
> adjudication: renames, handle collisions, released-handle tombstones and
> cross-runtime callers are all sound under this ordering, because both lookups
> read the same LIVE author rows.
>
> `agentPaths` is exposed nowhere, which the two-list shape below would have done:
> a directory path is a fact about the machine's filesystem, not about the room.

```ts
// create_room — a strict subset of CreateRoomRequestSchema (room-schemas.ts:1082-1113)
z.object({
  kind: z.enum(['channel', 'dm']),
  title: z.string().min(1).max(200).optional(),
  topic: z.string().max(500).optional(),
  agentPaths: z.array(z.string().min(1)).default([]),
  memberAuthorIds: z.array(z.string().min(1)).default([]),
});
// `slug` is NOT exposed: it is derived from the title, and letting an agent
// choose a channel's address invites SLUG_TAKEN churn for no gain.
// STRUCK 2026-08-29: this block used to claim "both cross-field refinements are
// inherited by calling the same service". They are NOT. `CreateRoomRequestSchema`
// is a REQUEST schema, and the capability builds a request object rather than
// parsing one through it, so neither refinement runs — which is exactly how a DM
// with no title came to be stored as the bare "#" the second refinement exists to
// prevent. What a shared service inherits is its GUARDS, never its caller's
// schema. The shipped capability derives a DM's title itself (see the §D8
// amendment above).

// add_room_members / remove_room_members
z.object({
  roomId: z.string(),
  agentPaths: z.array(z.string().min(1)).default([]),
  memberAuthorIds: z.array(z.string().min(1)).default([]),
});

// update_room
z.object({
  roomId: z.string(),
  title: z.string().min(1).max(200).optional(),
  topic: z.string().max(500).nullable().optional(),
});

// leave_room
z.object({ roomId: z.string() });
```

**`update_room` exposes `title` and `topic` only.** `UpdateRoomRequestSchema` (`room-schemas.ts:1117-1136`) carries eight fields; `archived` is the deferred lifecycle verb, `deliverNotices` is bridge-owned and refuses `NOT_A_BRIDGED_ROOM`, and the four `roomLimitOverrideFields` are operator-only at `updateRoom:1946` — the schema comment already states _"no room capability tool exposes them at all"_, and this spec keeps that true. `slug` is not patchable at all; it moves as a side effect of `title` via `renamedSlug:4352-4371`, and the tool description must say renaming a channel changes its `#name`.

On a system room, `requireSystemRoomWritable:4002-4014` refuses `title` for a non-owner and deliberately allows `topic` — _"A topic is a description, and describing a shared room is ordinary participation."_ So on `#team` an agent may set the topic and may not rename. Inherited, not restated.

> **Amended 2026-08-29 (orchestrator ruling on the review).** `update_room` also
> refuses `title` on a **direct message**, for a non-owner, with a new
> `TOOL_RENAME_NOT_IN_DM` following the `TOOL_POST_NOT_IN_DM` /
> `TOOL_LEAVE_NOT_IN_DM` naming. A DM's name IS its roster — it is derived from
> who is in it and re-derived whenever that changes
> (`dm-title-follows-roster`) — so a title an agent writes there survives only
> until the next membership change, and in the meantime it has renamed a
> conversation belonging to whoever else is in it. The topic stays writable, for
> the same reason it stays writable on `#team`. Spelled `kind !== 'channel'`, so an
> unrecognized kind takes the narrower branch. The owner is exempt: the cockpit is
> the person, and a name she chose for her own conversation is hers to change.

**Batch semantics.** `add_room_members` / `remove_room_members` take arrays and apply per member. They are **not atomic**: a refusal mid-list leaves earlier members applied. The output therefore reports per-member outcomes rather than a bare boolean, so a partial application is legible to the model instead of being inferred from an error:

```ts
z.object({
  applied: z.array(z.string()),
  refused: z.array(z.object({ handle: z.string(), code: z.string(), message: z.string() })),
});
```

> **Amended 2026-08-29.** `refused[]` is keyed `handle` rather than `id`, and what
> that field carries depends on how far the member got. A token that resolved to
> NOBODY echoes the caller's own token back, sanitized, because that is the only
> string either side has for it. A member that RESOLVED and was then refused by a
> room rule carries the resolved handle — or the display name, when the member has
> no handle — so the caller is told who it actually named rather than what it
> typed. Both are sanitized; neither is ever a raw string a model wrote. Both lists carry sanitized labels only — never a raw
> string a model typed. The lists are **deduplicated on the resolved author**, not
> on the string: `['bo', '@bo', ' BO ', '@@bo']` and `['@bo', '<bo's id>']` are each
> one member, and applying them once is what keeps "one line per member" true.

**Exposure.** All five are **deferred behind `ToolSearch`** with `searchHint`s, not `alwaysLoad`. The four existing room verbs earn `alwaysLoad` because _"a room turn is a person waiting in a shared channel, and DOR-1292 measured a whole turn lost to searching for one"_ (`tool-exposure.ts:78-83`). These are deliberate and occasional; always-loading five more schemas onto every turn of every session is the wrong trade the same file warns about.

### D9. `leave_room`, and the fallback seat

`removeMember(self)` alone is not sufficient — three findings:

1. **No last-member guard exists.** `RoomRoster.remove` (`room-roster.ts:203-207`) only checks the member exists; a room can be emptied.
2. **Leaving a 1:1 DM is unrecoverable, and the rule lives only in the client.** `RoomRowMenuItems.tsx:131-141`: re-opening mints _"a **SECOND** room rather than reopening this one — `findDmByMemberSet` needs an EXACT set match, and `{owner, agent}` matches nothing once the owner has left."_ The same holds in reverse for an agent.
3. **`requireSystemRoomKeepsOwner` only guards the owner** (`:4039-4046`), so an agent leaving `#team` — where DorkBot holds the fallback seat — is ungated today.

**Specified:**

- `leave_room` refuses when `room.kind !== 'channel'`, spelled as a positive test for the looser side exactly like `post_to_room`, per the standing rule that _"an unknown kind never gets more reach than a DM"_. New code **`TOOL_LEAVE_NOT_IN_DM`**, named after the existing `TOOL_POST_NOT_IN_DM`. Message: `You can only leave a channel. This is a direct message — it stays until the person archives it.`
- `leave_room` refuses a `wellKnown` room with `SYSTEM_ROOM`.
- **Emptying a channel is NOT refused, and that is a decision rather than an omission.** `RoomRoster.remove` (`room-roster.ts:203-207`) has no last-member guard, and none is added. An empty channel is recoverable in a way an orphaned DM is not: the row, its slug and its whole history survive, the owner sees every room on the install whether or not she is a member (`seesEveryRoom`), and she can add members back. Refusing would wedge the last member into a room it could never leave — the identical failure mode that made the fallback-seat refusal wrong. The asymmetry with the DM rule is the point: a DM cannot be re-entered because `findDmByMemberSet` needs an exact set match, and a channel can.

- **The fallback seat is cleared, not defended** (orchestrator ruling, absorbed item a). In `removeMember`, when the removed author is the room's `fallbackSeatAuthorId`, set it to `null` beside the existing `abandonHolds(roomId, authorId)` call at `:2171`. Refusing instead would wedge a seat-holder that can never leave, contradicting the standing guarantee that _"Taking an AGENT out is never refused, so nothing is ever wedged."_ This is a **correctness fix for all callers** of `removeMember`, not only the new verbs: `rooms.fallback_seat_author_id` is deliberately not a foreign key (`packages/db/src/schema/rooms.ts:315-318`), so nothing cleans it up today and a room can be left naming a seat that is not on its roster — a message nobody addressed then reaches nobody.

## User Experience

**Per-agent Tools tab** (`features/agent-settings/ui/ToolsTab.tsx`). The hard group renders in its **own `FieldCard`, visually separated** from the four soft rows, because merging them would make one paragraph describe two different mechanisms.

Replacement copy for the existing intro (`:228-233`), which currently ends with a claim that is false today for `act`-tier tools — _"if the agent asks for one anyway, you still get an approval prompt"_:

> Choose which tool groups this agent is told about. Turn a group off and the agent stops being told those tools exist, so it stops reaching for them. This is guidance, not a lock — an agent that asks for one anyway still gets it. Leave a group unset to inherit the global default.

New section, below, in its own card:

> **Manage rooms** — off
> Let this agent create channels and direct messages, add and remove members, rename a room, and leave a channel.
> **This switch is a lock, not a hint.** Unlike the groups above, turning it off blocks the calls: the agent is refused, and told to ask you. It is off until you turn it on, and only you can change it — the agent cannot turn it on for itself.
> It can never remove you from a room, and any room holding two agents holds you too.

**Global settings Tools tab** (`features/settings/ui/ToolsTab.tsx`). The group appears with **no switch** — there is no global default (D5), and inventing one would be a second, weaker grant path. It renders as a labelled row with a count and a pointer:

> **Manage rooms** — granted per agent. `N agents` can manage rooms. Turn it on for an agent in that agent's Tools settings.

**What the agent sees** when refused: the D2 message, as ordinary tool output on both servers (non-`isError`), so the model reads it and can relay it rather than treating it as a crash.

**What the operator sees**: a `capability.denied` Activity event for every refusal, so an attempt is visible even though it did nothing — and, per the existing choke-point observer, an audited record of every `act` call that succeeded.

**Runtime caveat.** The per-agent tab hides tool groups when the runtime cannot consume in-session MCP (`supportsDorkTools`, covering Codex and OpenCode). The **grant is still enforced** for those agents, because they reach the same capabilities through the external `/mcp` server. The Manage-rooms card therefore renders regardless of `supportsDorkTools`, with a line saying the agent reaches these over the external MCP server.

## Testing Strategy

**PR1 — the boundary.**

- **Add `roomDeps` to the conformance fixture.** `capability-conformance.test.ts:197-203` composes with `operatorDeps, marketplaceDeps, connectorDeps, mcpDeps` and no `roomDeps`, and `dorkos-registry.ts:62` gates the rooms domain on that key — so the six existing rooms verbs are outside the shared gate today. Prerequisite, not an extra.
- **Registry-derived conformance assertion**, modelled on the destructive-tier check (`packages/test-utils/src/capability-conformance.ts:519-560`): every capability declaring a `toolGroup` is refused through `registry.invoke` when the grant is off. Derived from the registry, so — like its model — it covers adapters that do not exist yet and cannot go vacuous.
- **Real `/mcp` enforcement test.** Extend `routes/__tests__/room-capabilities-unverified-agent.test.ts`, which already drives `createMcpRouter` + `createExternalMcpServer` over supertest with real JSON-RPC `tools/call` bodies. Its header states why it exists rather than living upstairs: _"the defect is in the WIRING: the registry-level tests … were all green while this was open."_ **Extend that file; do not start a new one.**
- **The fail-closed table (D1) as five cases**, one per row — including "identity present, lookup throws → refused", which is the row a naive implementation gets wrong.
- **Discrimination.** Same test, grant flipped on and off, asserting the outcome _changes_. A check that cannot fail is worse than none.
- **The self-grant defect reproduction (D6)**, written as a reproduction: an agent-path write setting `enabledToolGroups.roomsManage` is refused, and the operator's `PATCH /api/mesh/agents/:id` still succeeds. Red before the guard, green after.
- **`gate-bypass-scan.test.ts`**: roster writes join the protected-effect list, since its own TSDoc warns the list _"cannot fail for an effect nobody added"_.
- **Unchanged on purpose:** `claude-code-runtime.test.ts:1343-1374` still forbids anything setting `allowedTools`. The hard filter is not `allowedTools`, and reaching for that option is the mistake ADR-0070 paid for.

**PR2 — the verbs.**

- **Declaration snapshot.** `room-capabilities.test.ts:107-173` pins ids, tool names, tiers, servers and carve-out state; the five verbs go there.
- **Per-verb handler tests**, happy path plus **each row of the D7 refusal table**, including the two that are new behaviour: an agent removing the owner, and an agent leaving `#team`.
- **`leave_room`**: refuses in a DM (`TOOL_LEAVE_NOT_IN_DM`), refuses a system room, succeeds in a channel.
- **Fallback-seat cleanup**: removing the seat-holder clears `fallbackSeatAuthorId`; asserted through `removeMember` directly, since it is a fix for every caller.
- **The cascade sequence**, in both states: an agent **mid-turn** that creates a channel, adds a colleague and posts a mention triggers exactly one turn for the colleague; the same sequence with **no turn in flight** is stamped at the cascade ceiling (`cascade-guard.ts:173-174`) and triggers nobody, silently. Pinned because `create_room` makes a sequence that _looks_ like it starts a conversation reachable from a path where it does not.
- **Room multiplication, measured not fixed**: N rooms created by one agent do not buy N × the per-room turn allowance. This test records the `turn-budget.ts:30-35` property; the cap's default is explicitly out of scope.
- **`TOOL_ACCESS_CLAIM` carve-out** in `destructive-actions-prose.test.ts:723-735`, plus a test of the carve-out itself. **It lands in PR2, not PR1** — PR1 ships no user-facing claim, so the prose gate's premise stays true through PR1 and only PR2's UI copy makes the claim true.

**Mocking.** Existing fixtures throughout: `FakeAgentRuntime` and `@dorkos/test-utils` scenarios for server tests, the real composed registry for conformance, supertest for the `/mcp` leg. No new mocking strategy.

## Performance Considerations

One extra `readFile` + Zod parse per invocation of a `toolGroup`-declaring capability. Bounded by construction: only five capabilities declare one, all are deferred behind `ToolSearch`, and none is on the room-turn hot path that `alwaysLoad` exists to protect. Capabilities without the field pay one `undefined` check.

Deliberately **not** cached (D3): a stale grant is a correctness failure and the read is warm.

## Security Considerations

- **The self-grant seam is the one that would make this theatre**, and D6 closes it for this field. Its residual — a shell-capable agent curling the operator's route with login off — is the inherited `local-trust` gap, stated rather than papered over.
- **The grant gates the VERBS, and the roster's HTTP routes stay operator-only** (added 2026-08-29). The two are different surfaces and only one of them is an agent's. Enforcement lives at `registry.invoke`, which no route passes through, so a widened service method would have made the grant bypassable by a direct request — see the §D7 amendment for the regression this describes and the split that closes it. Do not read this as the `local-trust` residual above: that one is about a shell-capable agent impersonating the cockpit with login off, and it is unchanged. This one was a real hole with a real fix.
- **Prompt injection into a roster edit** is real: other members' text is untrusted input. Bounded by the grant (only agents the owner armed), membership (only rooms the agent is in), the three-way rule (no room the owner is not in), and D7 row 4 (never remove the owner). The honest residual: an armed agent can add another of the owner's agents to a channel it is in, which then receives that channel's traffic — the same outcome as the owner adding it by hand, and visible on the Activity feed.
- **A room id is never a capability**: "not a member" and "no such room" answer identically, preserved by keeping `requireVisibleRoom` first in every verb.
- **The dedupe check stays after the seeding gate** (`createRoom:1001-1015`), so a refused caller gets the same 403 whether or not the room exists and cannot probe for rooms.
- **Tier stays `act`, never `destructive`**, because a room triggers a turn into the dark where an approval card is unanswerable — measured at `interactive-handlers.ts:302-305`: _"Eleven minutes to answer one question."_ Bounds are the mechanisms above, per `.claude/rules/room-conduct.md`.

## Documentation

- **New ADR** (PR1): the first hard tool filter — the choke point, the fail-closed polarity argument, and the narrow self-grant closure. **Amends** `260726-171347` rather than superseding it; that ADR stays exactly right about the four soft groups. Not seeded as a draft here: this repo's `/adr:from-spec` _"applies the significance rubric at extraction — no draft state"_ (AGENTS.md).
- `decisions/260726-171347` — amendment noting its precondition is met for one key, and that its Follow-up (registration-time omission) is superseded by invoke-time enforcement, which reaches the stateless `/mcp` server that registration-time cannot.
- `specs/room-participation/02-specification.md` §10.2 — amend "gains **no** `rooms` key": the prohibition covers _conversation_ verbs; a management group under a different key does not reproduce the mute footgun.
- `decisions/260814-025326` — two stale lines: _"there is no delete, and no Leave"_ (DOR-1233 added Leave), and a consequences list predating any agent-reachable roster write.
- `.claude/rules/room-conduct.md` — _"An agent's hand in a room is four verbs"_ → six, plus five behind a grant; add the fail-closed rule and D7 row 4.
- `contributing/agent-operator-surface.md` — §"Identity is the ceiling, never the switch" gains its companion on positive per-agent grants.
- `packages/shared/src/mcp-tool-groups.ts:5-24`, `mesh-schemas.ts:111-144` — the D5 comment split.
- `docs/guides/agents.mdx:92` — new copy, **and fix the existing error** (it claims a disabled group's tool still prompts for approval).
- `contributing/architecture.md:647`, `agent-operator-surface.md:119` — the DOR-519 narrative gains its sequel.
- Changelog fragment in PR2 (the user-visible half), per `changelog/README.md`.

## Implementation Phases

**PR 1 — the boundary. Ships no new verbs.** `CapabilityToolGroup` + `toolGroup` on `CapabilityDefinition` (D4); `enforceToolGroupGrant` in `registry.invoke` (D1); `tool_group_disabled` (D2); `ToolGroupGrantLookup` and its manifest-backed implementation (D3); the `roomsManage` key and the three comment splits (D5); the `agent-updater` refusal (D6); `roomDeps` into the conformance fixture; the registry-derived assertion and the real-`/mcp` test; the new ADR and the doc corrections above.

Reviewable alone because the mechanism is proved against a fixture capability, without the rooms surface arguing for it.

**PR 2 — the verbs.** `requireRosterWriteAllowed` and the `addMember`/`removeMember` agent paths (D7); the `requireOwnerWitnessesAgents` TSDoc correction; the five capability definitions and the declaration snapshot (D8); `TOOL_LEAVE_NOT_IN_DM` and the `leave_room` guards; the fallback-seat cleanup (D9); both Tools tabs (§UX); the `TOOL_ACCESS_CLAIM` carve-out; user docs and the changelog fragment.

## Acceptance Criteria

A reviewer can check each of these directly.

1. Turning **Manage rooms** off for an agent and calling `add_room_members` as that agent returns `status: 'denied'`, `reason: 'tool_group_disabled'`, `approvable: false` — **on both** the in-session and external `/mcp` servers.
2. The same call with the grant **on** succeeds. (1) and (2) differ only in the grant.
3. A call to a `toolGroup`-declaring capability with **no identity** is refused, on both servers.
4. A grant lookup that **throws** produces a refusal, not an allow.
5. An agent writing `enabledToolGroups.roomsManage` through `PATCH /api/agents/current` or `update_agent` is refused; the operator's `PATCH /api/mesh/agents/:id` still writes it.
6. Turning the switch off takes effect on the **next call**, with no restart.
7. An armed agent **cannot** remove the install owner from any room, in any roster shape.
8. An armed agent cannot produce a room holding two agents without the owner, through `create_room` **or** `add_room_members`.
9. `update_room` cannot set `archived`, `deliverNotices`, or any turn-limit field — they are absent from its input schema.
10. `leave_room` refuses in a DM and on `#team`, and succeeds in an ordinary channel.
11. Removing an agent that holds the room's fallback seat leaves `fallbackSeatAuthorId` null rather than dangling.
12. `capabilityConformance` runs against a registry that **includes** the rooms domain, and fails if any of the five verbs loses its declared surfaces or stops being REFUSED without the grant. A verb that silently **loses** its `toolGroup` is caught by the declaration snapshot in `room-capabilities.test.ts`, which pins each verb's group by name — not by conformance, whose subject set is derived from the declarations themselves and therefore shrinks rather than fails when one is deleted. _(Corrected 2026-08-29: the original wording credited conformance with a guarantee a mutation showed it does not have.)_
13. No page, doc, or UI string claims tool-access control except where it is now true; `destructive-actions-prose.test.ts` passes with a carve-out that itself has a test.
14. `claude-code-runtime.test.ts`'s `allowedTools` guard is unchanged and passing.

## Decisions Register

Every decision is settled. No open questions remain.

| #   | Decision                                                                                                      | Settled by                                  |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| S1  | Five verbs; `archive_room` deferred                                                                           | Operator                                    |
| S2  | Hard filter at one choke point on `registry.invoke`                                                           | Operator (2026-08-28)                       |
| S3  | All five tier `act`, never `destructive`                                                                      | Operator                                    |
| S4  | Create channels + DMs; add anyone; remove anyone except the owner; system rooms and three-way rule unchanged  | Operator                                    |
| S5  | Default off; granted per agent; one group for all five                                                        | Operator                                    |
| S6  | Conversation verbs stay untoggleable                                                                          | Operator                                    |
| S7  | Group appears in both Tools tabs, with copy that says it blocks and does not imply the others do              | Operator                                    |
| D1  | Fail closed on absent identity, absent grant, or a throwing lookup                                            | Ideation                                    |
| D2  | `tool_group_disabled` on `TierDeniedReason`, `approvable: false`                                              | Ideation                                    |
| D3  | Boot-injected lookup, read fresh, manifest-sourced                                                            | Ideation                                    |
| D4  | `toolGroup` on `CapabilityDefinition`; UI reads the live registry                                             | Ideation                                    |
| D5  | Key name `roomsManage`; `undefined` = off                                                                     | Ideation                                    |
| D6  | Narrow self-grant closure in PR1; full policy stays DOR-1506                                                  | **Orchestrator** (2026-08-27)               |
| D7  | No global default                                                                                             | **Orchestrator** (approved ideation D7/D8)  |
| D8  | Global tab row carries no switch                                                                              | **Orchestrator** (approved ideation D7/D8)  |
| D9  | `requireRosterWriteAllowed`; `requireOperator` unrelaxed                                                      | Ideation                                    |
| D10 | An agent may never remove the owner, in any shape                                                             | Operator (S4), mechanism from ideation      |
| D11 | Reuse the existing DM dedupe; build nothing                                                                   | Ideation                                    |
| D12 | `update_room` exposes `title` + `topic` only                                                                  | Ideation                                    |
| D13 | `leave_room` channels-only, refuses system rooms                                                              | **Orchestrator** (approved ideation D13)    |
| D14 | Deferred behind `ToolSearch`, not `alwaysLoad`                                                                | Ideation                                    |
| D15 | Fallback seat **cleared** on removal, not defended by a refusal                                               | **Orchestrator** (absorbed scope a)         |
| D16 | `TOOL_ACCESS_CLAIM` carve-out lands in PR2, not PR1                                                           | **Orchestrator** (absorbed scope b)         |
| D17 | Global turn-cap default deferred out of this programme                                                        | **Orchestrator** (2026-08-27)               |
| D18 | These five capabilities are agent-only by construction                                                        | Specify (derived from D1)                   |
| D19 | Batch member verbs are non-atomic and report per-member outcomes                                              | Specify                                     |
| D20 | `create_room` does not expose `slug`                                                                          | Specify                                     |
| D21 | Member lists take a `@handle` **or** an author id, resolved in that order                                     | **Orchestrator** (2026-08-29, on review)    |
| D22 | `update_room` refuses a title change on a DM (`TOOL_RENAME_NOT_IN_DM`); the topic stays writable              | **Orchestrator** (2026-08-29, on review)    |
| D23 | Removing YOURSELF is leaving, whichever verb asked — both refusals live in `removeMember`                     | **Orchestrator** (2026-08-29, on review)    |
| D24 | A `SLUG_TAKEN` refusal names the holding channel only to a caller who can already see it                      | **Orchestrator** (2026-08-29, on review)    |
| D25 | The grant does not unlock HTTP: roster routes stay operator-only, agents reach rosters only through the verbs | **Orchestrator** (2026-08-29, on PR review) |

## Open Questions

None. The four flagged in `01-ideation.md` §7 were ruled on by the orchestrator on 2026-08-27 and are recorded above as D6, D7/D8, D13 and D17.

## Related ADRs

- `260726-171347` — Tool-group toggles gate context, not access. **Amended by this work.**
- `0070` — Per-agent tool filtering via `allowedTools`. Superseded; its post-mortem is why D1 is invoke-time and not `allowedTools`.
- `260814-025326` — The three-way rule for agent-seeded rooms. Held unchanged; extended to a new caller kind.
- `260814-024525` — Bridged rooms are projections, not communities.
- `260726-170125` — No arbitration in rooms. Constrains D7 (why `updateMembership` gains no agent path).
- ADR-0043 — File-first agent storage. Governs D6's write path.

## References

- `DOR-1611` (this work); `DOR-1506` (blocking dependency, narrow closure only); `DOR-608` (blocks `archive_room`); `DOR-519` (deleted the `allowedTools` wiring); `DOR-467`/`DOR-468` (put the tier gate inside `invoke`); `DOR-1229` (the eleven-minute measurement); `DOR-1233` (added Leave); `DOR-1292` (the turn lost to `ToolSearch`).
- `specs/rooms-management-tools/01-ideation.md` — the evidence trail behind every decision here.
- `specs/room-participation/02-specification.md` §10.2; `specs/rooms/02-specification.md` §12.4.
- `.claude/rules/room-conduct.md`; `contributing/agent-operator-surface.md`; `meta/agent-etiquette.md`.
