---
title: 'Rooms, DMs, channels and communities — the planned design, synthesized from the spec corpus'
date: 2026-07-27
type: codebase-audit
status: active
tags:
  [
    rooms,
    channels,
    dms,
    communities,
    community-adapter,
    community-server,
    locked-decisions,
    spec-drift,
  ]
feature_slug: room-participation
---

> **Why this exists.** Produced while writing `specs/room-participation/01-ideation.md`,
> which carries only the twelve most load-bearing of the constraints below. This is the
> long form: a spec inventory with statuses, ~72 numbered constraints with `file:line`
> citations, and the drift between specs that nothing else records. Read it before
> designing anything in this area — the value of a constraint inventory is the entries
> you would not have thought to ask about.
>
> Anchor: `main` @ `a06b6d83b`, 2026-07-27. Statuses and line numbers drift; re-check
> anything load-bearing rather than citing this file second-hand.

# Rooms / DMs / Channels / Communities — the PLANNED design, synthesized

Scope: everything in the planning corpus (`specs/`, `decisions/`, `plans/`, `docs/`) except the shipped
code (another agent) and `specs/community-adapter/01-ideation.md` + `specs/community-server/01-ideation.md`
(the operator is reading those personally — D1–D9 are still summarized here because the whole locked-decision
set depends on them).

Anchor: repo `main` @ `a06b6d83b`, 2026-07-27.

---

## 1. Spec inventory

Statuses are from `specs/manifest.json` (324 entries). **`implemented` ≈ shipped and authoritative;
`specified` = frozen design, not yet fully built; `ideation` = still being shaped.**

### The community / rooms program (all July 2026 — this is the live design)

| Spec                             | Id            | Status                                           | Relevance                                                                                                                                |
| -------------------------------- | ------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `community-adapter`              | 260727-221432 | **specified**                                    | The centerpiece. Defines the `CommunityAdapter` port — one server-side seam over local SQLite rooms, a Buzz relay, and `apps/community`. |
| `community-server`               | 260727-155419 | **ideation**                                     | D1–D9: what a community server IS, where it lives, roles, agent admission, no hosted execution.                                          |
| `invites`                        | 260727-161438 | **specified** (retargeted)                       | Invite tokens, the `member` role, default-deny role gate. Host moved from `apps/server` to `apps/community` after D6.                    |
| `rooms`                          | 260726-170533 | **specified** (R0–R3a + R5/R6 shipped in phases) | The canonical local model: channel / DM / thread, membership, addressing, cascade guard, slash commands.                                 |
| `channel-workspace`              | 260726-162747 | **specified**                                    | A room's shared working context as a git repo layered onto members' agents via Harness Sync.                                             |
| `multi-participant-message-list` | 260725-014841 | **specified**                                    | Phase 1 of the message list: author identity, gutter grammar, dividers. Client-only.                                                     |
| `agent-workspace-binding`        | 260726-162520 | specified                                        | Sibling; owns "the agent's workspace root". Referenced, not read in depth.                                                               |
| `agent-trust`                    | 260723-050355 | **implemented**                                  | Agent identity tokens, capability tiers, approvals. Supplies the identity primitives communities reuse.                                  |
| `capability-registry`            | 260723-013455 | implemented                                      | One boot-composed registry generating every agent-facing surface.                                                                        |
| `agents-as-operators`            | 260722-220011 | implemented                                      | Agents as first-class operators; tier-gated destructive actions.                                                                         |
| `accounts-and-auth`              | (legacy)      | implemented                                      | Better Auth OSS login + DorkOS Cloud identity — the identity core all three products share.                                              |

### The OLDER "channel" corpus — a DIFFERENT meaning of the word

These all use **"channel" = an external messaging integration** (Telegram/Slack/Discord/webhook bound to an
agent), NOT an in-cockpit conversation. See §7 for the rename that settled this.

| Spec | Status | Relevance |
| ------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `channels-and-agent-adapters` (2026-04-04) | implemented | Connectivity UX for external adapters. "Channel" = integration. |
| `adapter-agent-routing` (2026-02-28) | implemented | Central BindingRouter routes an inbound external message to one agent (ADR-0046). |
| `adapter-binding-improvements` (2026-03-22) | implemented | Binding robustness, multi-instance routing. |
| `channel-sender-identity` | 260721-215926 | implemented | Forwards the external sender's identity into the prompt + session UI. |
| `agent-channels-tab-01/02/03` | implemented | The agent dialog's integration-binding tab. |
| `agents-first-class-entity` (2026-03-29) | implemented | Agents as an entity with their own registry. |
| `agent-tool-context-injection` (2026-03-03) | implemented | Static XML context blocks (ADR-0068). |
| `auto-hide-tool-calls` (2026-02-12) | implemented | Unrelated to rooms. |
| `a2a-channels-interoperability` | **not in the manifest** | See §7.4. |

Relay/Mesh corpus (~40 specs, all `implemented`) is the transport substrate underneath integrations; the
rooms design deliberately does **not** ride it (ADR 260726-170127).

### Accepted ADRs that bind this design

| ADR             | Status   | What it locks                                                                                    |
| --------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `260726-170125` | accepted | A room is a membership-scoped durable stream, not a session.                                     |
| `260726-170126` | accepted | Persisted author identity is an opaque id keyed on the agent's **directory**, never its ULID.    |
| `260726-170127` | accepted | The room path carries its own cascade guard + turn budget, not the relay's envelope.             |
| `260726-193526` | accepted | "Channel" = a conversation; Relay's external adapters = "Integrations". **Supersedes ADR-0224.** |
| `260727-184933` | accepted | The community server never runs a member's agent; hosted DorkOS is three products.               |
| ADR-0310        | accepted | Runtime-owned storage, registry-aggregated listing, per-backend degradation + `warnings[]`.      |
| ADR-0255        | accepted | Per-session runtime binding, first-write-wins.                                                   |
| ADR-0256        | accepted | Structured capability fields over a flat `features` bag.                                         |
| ADR-0043        | accepted | File-canonical source of truth with a derived cache.                                             |
| `260725-133220` | accepted | The action's tier decides the gate; identity only caps it.                                       |
| `260726-022251` | accepted | In-session agent identity comes from the working directory, not a presented token.               |
| ADR-0320        | accepted | Optional-by-default local login, required on exposure (the trust-domain argument).               |

---

## 2. The intended conceptual model

### 2.1 Room is the container; channel / DM / thread are its three kinds

`specs/rooms/02-specification.md:15-21` gives the vocabulary verbatim:

> **Room** — A membership-scoped durable stream. Three kinds: `channel`, `dm`, `thread`.
> **Author** — Anyone who can post: a human, an agent, or the system. Identified by an opaque `authorId`.
> **Membership** — An author's binding to one room, carrying that room's addressing override and read cursor.
> **Entry** — One durable, turn-atomic item in a room's log. Either a `post` or a `notice`.
> **Integration** — The renamed Relay concept — an external adapter (Telegram, Slack, webhook).

A room is emphatically **not** a session (ADR `260726-170125:29-31`): "Three agents in a room are three
sessions on one stream. Each session keeps its own runtime binding, working directory, context window and
lifecycle; the room owns only the shared stream and the roster." That is the reason a mixed-runtime room is
possible at all — a session binds to a runtime at first write (ADR-0255) and can never be multiplexed.

### 2.2 The anchoring distinction — the one-liner that belongs in docs verbatim

`specs/rooms/02-specification.md:600-606`:

|             | Anchored to        | Holds                                  | Ends when               |
| ----------- | ------------------ | -------------------------------------- | ----------------------- |
| **Session** | a **working tree** | one agent, one runtime                 | the work does           |
| **DM**      | a **participant**  | one or more agents, no tree of its own | never — a standing line |
| **Channel** | a **topic**        | any number of agents, by name          | you archive it          |

> **a session is about a directory, a DM is about who you are talking to, and a channel is about what you
> are talking about.** (`rooms/02-specification.md:606`)

Consequences stated as load-bearing (`:608-612`): a DM has **no `cwd`** — ask an agent to do work in a DM and
it works wherever it lives via its workspace binding, so "promote this to a session" is the bridge, not a
synonym. A channel is the only one with **a name people type**, which is why it alone has a slug.

### 2.3 A thread

Storage-wise: **a thread is a child room** — same entity with a `parentId`, exactly one level deep; a thread
of a thread is refused at the service boundary with a typed error, never silently flattened
(`rooms/02-specification.md:71`, ADR `260726-170125:29`). `rooms.rootEntryId` points at the parent entry the
thread hangs off (`rooms/02-specification.md:61`). The "N replies" summary row is a projection of the child's
log, not a new storage concept.

**But at the community port, a thread is an entry-level relation** — see §6.1, the sharpest drift in the
corpus.

### 2.4 A community

`specs/community-server/01-ideation.md:180`, the design principle:

> **Each community is its own front door.** You sign up to _that community_ — email and password, or Continue
> with Google, or Continue with GitHub. The community's owner runs the server, owns the roster, holds the
> messages. DorkOS-the-company is nowhere in the middle.

Where it lives: **`apps/community`, a new self-hostable Next-style app running Postgres**, copying (not
importing) `apps/site`'s Better Auth setup (D4, `community-server/01-ideation.md:94-100`). Not in `apps/site`
(that conflates the marketing/cloud service with self-hosted software) and not a "hosted mode" inside
`apps/server` (every local install would carry code it never runs).

**Not federated.** `community-server/01-ideation.md:223`: "Matrix-style state resolution was evaluated and
rejected as disproportionate; Block chose not to build it into Buzz either. **A community is authoritative for
itself.**"

**Not hosted compute.** ADR `260727-184933` splits "hosted DorkOS" into three products: (1) remote access to
your own install — **already shipped** via the tunnel + ADR-0320's exposure guard; (2) a hosted community
server with a browser client — **being built**; (3) hosted agent execution — **a separate future product, not
scheduled** (`:36-40`).

### 2.5 The community adapter

`specs/community-adapter/02-specification.md:21-29` — one port, three backends:

```
client ──Transport──▶ your local DorkOS server ──CommunityAdapter──▶ ┌ local rooms   (SQLite, shipped)
       (unchanged)                                    (new)          ├ Buzz relay    (Nostr/WS, read-only)
                                                                     └ apps/community (Postgres)
```

The port is `packages/shared/src/community-adapter.ts`; its gate is `communityConformance` in
`@dorkos/test-utils`; its dispatcher is a `CommunityRegistry` in `apps/server/src/services/communities/`
aggregating with per-community degradation and `warnings[]` (`:29`). It is the **fourth swappable seam beside
`AgentRuntime`, `Transport` and `ConnectorProvider`** (`:294-296`).

**No concrete adapter ships in that spec** (`:31`). The deliverable is the contract + the suite. Order is D5's:
local → Buzz read-only → `apps/community`.

### 2.6 Who owns what

| Thing                                                     | Owner                                                |
| --------------------------------------------------------- | ---------------------------------------------------- |
| Your agents, filesystem, model credentials, git checkouts | your machine, forever (D6, ADR `260727-184933`)      |
| Local rooms, read cursors, your purely-local rooms        | your SQLite cache                                    |
| Community roster, permissions, full history, invites      | the community's Postgres (D1)                        |
| An agent's compute                                        | always the owner's machine (D9)                      |
| A room's shared conventions (AGENTS.md/skills/commands)   | a git repo, cloned per machine (`channel-workspace`) |

D1 frames local-vs-server as **source of truth and cache**, the ADR-0043 pattern, "not two copies of one
database" (`community-server/01-ideation.md:49`).

---

## 3. Multi-agent membership — what is already committed

**Several agents in one room is the design target, not an edge case.**

- **Storage.** `room_sessions (roomId, authorId, sessionId)` — "Three agents in a room means three rows here —
  three sessions on one stream, each keeping its own runtime binding (ADR-0255)"
  (`rooms/02-specification.md:132`).
- **Addressing is per membership, not per agent.** `room_members.responseMode ∈ {always, direct-only,
mention-only, silent}` (`rooms/02-specification.md:78`). It reuses `AgentBehaviorSchema.responseMode` from
  `mesh-schemas.ts:62` rather than declaring a second enum (`:150`). The manifest value is the **default**;
  the membership row is the **override** (ADR `260726-170125:34`), written explicitly at join time so there is
  no dynamic rule to reason about later.
- **Seeding by kind** (`rooms/02-specification.md:86-92`): `dm` → the agent's manifest value (default
  `always`); `channel` → `mention-only`; `thread` → inherit the parent room's membership value.

### 3.1 The routing rule — decided, and deliberately NOT arbitration

`rooms/02-specification.md:228-236`. On a committed `post` by author A in room R, for each agent member M
where `M.authorId !== A.authorId`:

| `M.responseMode` | Triggered when                                      |
| ---------------- | --------------------------------------------------- |
| `silent`         | never                                               |
| `mention-only`   | `M.authorId ∈ entry.mentions`                       |
| `direct-only`    | `R.kind === 'dm'`, or `M.authorId ∈ entry.mentions` |
| `always`         | always                                              |

Then the cascade guard may veto. Survivors are triggered on their `room_sessions` row, creating the session
if absent — **first-write-wins binding**, which is what makes an agent's per-room context survive across
messages (`:237`).

**The explicit non-decision** (`rooms/02-specification.md:241`):

> "Addressing three agents and getting three answers is the intended outcome, not a pathology. `responseMode`
> exists to stop agents answering when they were **not** addressed; it makes no attempt to order or serialise
> the ones who were."

So: **there is no arbitration, no turn-taking, no "who should answer" selection.** Fan-out is the model. If
you want arbitration, you would be adding something the spec deliberately declined.

- **What the agent says becomes a post** (`:239`). The turn runs through the normal `triggerTurn` path — a
  visible session turn, not invisible work — and the reply is written back as a `post` authored by that agent,
  carrying the triggering entry's provenance (`cascadeRoot`, `cascadeDepth + 1`).

### 3.2 Mentions

`rooms/02-specification.md:245`: `mentions.ts` parses `@name` **at post time** against the room's roster
(agent name, then author `displayName`), resolves to `authorId[]`, stores the resolved list on the entry.
Resolution happens once, at write; the client renders from the stored list and never re-parses. An
unresolvable `@name` stays plain text.

### 3.3 The cascade guard + turn budget (the anti-runaway design)

ADR `260726-170127` and `rooms/02-specification.md:253-268`. Two rules, ordered:

1. **Depth.** `depth = E.cascadeDepth + 1`; refuse past `maxAgentDepth` (config, default **3**).
2. **Ancestry.** Refuse if the target author already appears in
   `SELECT DISTINCT author_id … WHERE room_id = ? AND cascade_root = E.cascadeRoot`.

Ancestry is the load-bearing rule; depth "only ever fires for a chain of _distinct_ agents"
(`rooms/02-specification.md:268`). A **human** post always starts a fresh cascade (`cascadeRoot = own id`,
depth 0), so a person can always re-engage a stopped room (`:258`).

A refusal writes a **`notice` entry** into the room, in the room's voice, one per agent per cascade, not per
refusal (`:260-266`). "A silently dropped trigger is indistinguishable from a broken agent."

Plus a **posture-independent turn budget** (`turn-budget.ts`) with two ceilings — per-room and global — that
counts without reference to who is calling (ADR `260726-170127:66-79`). Both windows are in-memory and reset
on restart (`:87`).

Known limit, stated in the ADR (`:127-134`): **cross-room cascades carry their depth but not their ancestry**
— `authorsInCascade` is scoped `(room_id, cascade_root)`, so the same author can appear once per room within
one cascade. The ancestry rule is a **within-room guarantee only**.

Known residual (`:55-64`): with login off, `resolveCaller` cannot tell a local program from the person, so a
header-omitting caller _is_ the human author. Measured: 30 posts → 30 distinct cascade roots, 60 turns, max
depth 0, no refusal notice. The fix is "login being enabled", not a room-path change.

### 3.4 Group DMs

`rooms/02-specification.md:449-461` (R6a / DOR-571). One agent → 1:1; two or more → a group conversation named
from the participants. The duplicate-prevention guarantee moved **server-side**:

> `POST /rooms` with `kind: 'dm'` returns the **existing** room when a DM with exactly that member set already
> exists. (`:458`)

Adding an agent to a DM happens **in place**, not by forking a new conversation (`:482`) — Slack forks for
privacy between people who don't own each other's accounts, which does not apply when every participant is
one of your own agents.

### 3.5 Slash commands in a multi-agent room (DOR-603)

`rooms/02-specification.md:634-709`. Two kinds:

- **Room commands** (`/add`, `/remove`, `/topic`, `/rename`, `/archive`) act on the room, need no tree, work
  everywhere.
- **Agent commands** (plugin commands, skills like `/flow:specify`) need a tree, so a room resolves them
  **through an agent**, which has a workspace binding.

Rule (`:655-659`): in a 1:1 DM the agent is unambiguous, so agent commands just work. **In a group DM or a
channel the agent is ambiguous, so an agent command requires an address: `@kai /flow:specify`.** A bare agent
command in a multi-agent room makes the composer _ask_ which agent. `:707` — "**guessing which agent runs a
command is the one outcome that is not acceptable**."

Invariant (`:682-684`): "Every room command has a menu equivalent, and every menu item has a command. A
capability that exists in only one of the three is a bug in whichever two are missing it." One pure node list
(`buildRoomRowMenuNodes(model)`), three renderers: context menu, `…` dropdown, slash menu — plus the palette.

---

## 4. Cross-person interaction

### 4.1 Identity across a community

- **Local author identity** is an opaque ULID `authorId` resolved through `(kind, naturalKey)` with
  mint-on-first-use. For an agent the natural key is its **`agentPath`**, never its manifest ULID
  (ADR `260726-170126:28`, `rooms/02-specification.md:35-45`). Rationale includes the community case directly
  (`ADR 260726-170126:33`): "A raw path leaks the filesystem into the wire format… the community direction
  makes some of those rooms shared with other people. Every message, reaction and roster entry would otherwise
  carry `/Users/dorian/…` to every member."
- **A remote member's `naturalKey` is the opaque member id that community minted** — "Slack's `U024BE7LH`,
  not an email" (D3, `community-server/01-ideation.md:86`). Only the opaque local `authorId` ever reaches the
  wire (`community-adapter/02-specification.md:121`).
- Accepted cost: **the same person in two communities is two author rows locally** — "That is what Slack does.
  It is joinable later with a link table — never a key migration" (`community-server/01-ideation.md:90`).
- **Zero user-facing keys, in every path** (D3, `:92`). Email+password / Google / GitHub. The Nostr secp256k1
  keypair is _machine infrastructure in a `0600` file_, modeled on `resolveBetterAuthSecret` (`:125`).
- A second human human author is `user:<betterAuthUserId>` (`invites/02-specification.md:363`), and the
  existing `'local'` sentinel is **rebound in place** at owner creation so no message moves (`:373-391`).

### 4.2 Other people's agents in your rooms — D8, the agent-admission model

D8 (`community-server/01-ideation.md:154-164`) + `community-adapter/02-specification.md:52,387-399`:

- **No approval step.** A member adds an agent to any channel they belong to. "It is the whole point of the
  product rather than a feature to gate."
- **The agent gets its OWN identity in the community, vouched for by the member who brought it.** Not a
  shared credential, not the owner's identity.
- **Removing the human removes their agents**, automatically, because the attestation is what admits them.
  Buzz's own implementation fails this and that hole is explicitly not copied.
- **The agent inherits none of its owner's powers.** "A member's admin-less agent is not an admin's agent.
  Capability does not flow owner → agent."
- **Admins can eject an agent** or bar it from a channel without removing its owner.
- **Quotas must aggregate per owner, not per identity.** Buzz's are inverted (agents get 120 msg/min vs a
  human's 60 on independent counters, so N agents buy `60 + 120N`) — "that is D8's stated hole and it must be
  closed at `apps/community`, not inherited" (`community-adapter/02-specification.md:704`).

Mechanically at the port (`community-adapter/02-specification.md:387-399`): `admitAgent(input)` /
`revokeAgent(memberId)`, gated on `agentAdmission: 'owner-vouched'`. Three contractual properties: the
returned member's `ownerMemberId` is the connected identity; **its role NEVER administers**, whatever its
owner's role is; **its admission is DERIVED from its owner's, re-evaluated on use** rather than copied into a
row a cleanup job must find. Conformance assertion C10/P1–P4 (`:671`) — P4 is asserted **by use**, not by a
row disappearing.

Refused mechanism (`:65`, `:506`): Buzz's NIP-OA signed capability. "We take the motivation and refuse the
mechanism: a join at read time, not a signed capability the owner cannot revoke."

**Agents never authenticate to a remote community directly** (OQ4 RESOLVED, `:65`): "Under D2 an agent talks
to its owner's own DorkOS server, and that server talks to the community; there is no agent-to-community
credential in v1."

### 4.3 Roles and permissions

Three distinct role models, and they are deliberately different:

| Scope                | Roles                                                                                   | Source                                                     |
| -------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Local install**    | none — "it is yours"                                                                    | D6, `community-server/01-ideation.md:133-138`              |
| **Community server** | `owner` (exactly one, irreducible: they hold the DB) / `admin` (many) / `member` (many) | D7, `:146-152`                                             |
| **The port**         | adapter-declared vocabulary, one portable predicate                                     | `community-adapter/02-specification.md:62,173-178,258-265` |

D7 is explicitly **not a permission system**: "three named roles, no per-resource grants. Per-channel roles are
much easier to add later than to remove" (`community-server/01-ideation.md:150`). "A community with exactly
one administrator stops working the week that person goes on holiday."

At the port, roles are `{ supported, default?, values: CommunityRoleDescriptor[] }` where each descriptor is
`{ id, label, administers: boolean, isOwner?: boolean }`. **`administers` is the only predicate the product
branches on; the UI renders `label`** (`community-adapter/02-specification.md:258-265`). A shared three-value
enum was rejected on the evidence that Buzz has five with `Bot` explicitly outside the hierarchy (`:62`).

`invites/02-specification.md:316-334` enumerates a `member`'s May / May-not lists in full (see the banner
caveat in §6.4 — it was written against **two** roles, and D7 makes it three). Highlights of May-not: see a
room she is not in (`requireVisibleRoom` answers `ROOM_NOT_FOUND` for both "no such room" and "not yours");
add/remove/reconfigure any member including her own response mode; create/revoke/list invites; read or write
instance configuration; create or run agents outside a room she belongs to.

**The enforcement shape is decided** (`invites/02-specification.md:336-349`) — "an allow-list, not a
deny-list, and this is the single most important structural choice in §3." One `roleGate` middleware after
`sessionGate`, an allow-list array in `services/core/auth/member-routes.ts`, and **a coverage test that
enumerates every mounted router and fails the build on an unclassified one**. The retarget banner (`:33`)
notes the reviewer's finding that the coverage test must enumerate _every_ file that mounts routers, not just
`app.ts`.

### 4.4 Visibility

Local, today (`rooms/02-specification.md:195-199`):

- **The local human sees every room.** "This is a single-player cockpit; 'membership-scoped' describes the
  model, not an authorization rule against the person running the machine."
- **An agent sees only rooms it is a member of.** "An agent enumerating the operator's DMs with other agents is
  an information leak, and it costs one join to prevent."
- **`unreadCount` is only meaningful for a room you are a member of.** Never return the room's full entry
  count for a non-member.
- **The author of a request is resolved server-side, never from the request body** (`:203`). A body-supplied
  `authorId` is ignored, with a test asserting it. "In a shared room [that] is impersonation rather than a
  data-integrity nit."

The known landmine (`community-server/01-ideation.md:205-211`, `invites/02-specification.md:414-436`):
`seesEveryRoom()` and `requireOperator()` both grant on `kind === 'human'`, and the client locates the viewer
with `members.find(m => m.author.kind === 'human')`. **All of it activates the instant a second human author
exists — which joining a community causes on your own machine, with no second account anywhere** (D6, `:144`).
The fix (`isOwnerAuthor`, `viewerAuthorId` on `RoomWithRoster`) shipped as DOR-598
(`invites/02-specification.md:33`).

### 4.5 What the cross-person experience is meant to feel like

`community-server/01-ideation.md:184-197` — the MVP beats: (1) Dorian clicks Invite in a channel, gets a link,
no form; (2) Priya opens it and sees the community name, who invited her, and the channel **before signing
up** — "an invite that shows you nothing is a form, not an invitation"; (3) one screen, Google / GitHub /
email+password, no username to invent, no verification wall; (4) she lands **in the conversation**, not an
empty state; (5) **she brings her agents** — "her Claude Code, on her machine, posting in Dorian's channel.
That is the demo, not a follow-up."

Two cheap commitments: **ownership visible, not configurable** (one line: "Dorian runs this community"), and
**the exit is real** (leave and your local copy goes with you). Refused: email required to preview an invite;
"install the app to continue"; **any screen containing the word "server" that a joining member has to read**.

Availability, accepted as a property not a bug (ADR `260727-184933:48`): **"Presence follows the install."**
If a member's computer is off, that member and their agents are offline. v1 does not queue and does not
promise a later reply.

### 4.6 Cross-person shared context — channel workspaces

`specs/channel-workspace/02-specification.md:17`: "A **channel workspace** is a git repo that carries a
room's shared _working context_ — its `AGENTS.md`, its skills, its commands. Every member clones it; DorkOS
layers it onto each of that member's participating agents, on top of everything the agent already has."

Locked properties:

- Layering is **additive by construction** — joining never removes, renames, or overrides anything
  (`:34`). Skills/commands are namespaced `<channelSlug>__<name>`, so collision is impossible (`:107-108`).
- **Instructions cannot be projected to disk** (`:21`, §3.5). They ride the turn via `systemPromptAppend`
  (ADR-0273). Precedence is **stated in the composed text, not positional**, and honestly labeled advisory
  (`:109`, `:112`).
- **Hooks are excluded by design, not scope-cutting** (`:174`). "A channel that ships hooks is arbitrary code
  execution granted by a social act" (`:168`). Consent-on-every-pull is rejected as approval fatigue that
  "manufactures a record of consent that was never given" (`:171`).
- **The invariant that makes the rest safe: a channel workspace can never change a member's permission
  posture** (`:183`).
- **Joining is operator-only, never an agent capability** (`:186`) — "An agent told by a message in one channel
  to join another is the confused-deputy shape."
- The consent sentence, verbatim (`:188`): _"Anyone who can push to this channel can write instructions and
  skills that reach your agents. They cannot change what your agents are allowed to do."_
- The sidecar (`channel.json`) lives **outside** the clone so the channel cannot rewrite its own consent
  record, pin policy, or origin (`:74`).
- **No agent's `cwd` is ever a channel checkout** (`:52`) — direct application of the DOR-500 measurement.

---

## 5. Decisions already locked — the constraint list

These are accepted ADRs or frozen `specified`/`implemented` specs. A new design must respect all of them or
explicitly supersede them.

### From ADRs (highest authority)

1. **A room is a membership-scoped durable stream, not a session.** Three agents in a room are three sessions
   on one stream; the room owns only the stream and the roster. (ADR `260726-170125:26-31`)
2. **A thread is a child room, one level deep, refused at the service boundary if nested.** (ADR
   `260726-170125:29`; `rooms/02-specification.md:71`) — narrowed at the community port, see §6.1.
3. **Membership is where per-room state lives**; the read cursor is keyed `(member, room)`, not per client, not
   per session. (ADR `260726-170125:32-33`)
4. **Addressing is per membership**; `responseMode` is the same shipped enum on a second scope, written
   explicitly at join time. The manifest value is only the default. (ADR `260726-170125:34`)
5. **The room log is turn-atomic and its own store.** Entries are written at `turn_end`. Ephemeral signals
   (typing, presence, receipts, progress, backpressure) are never durable. Pending interactions live in their
   own store and are projected in. **There is no trim — a room never discards entries.** (ADR
   `260726-170125:36-53`; `rooms/02-specification.md:120,222`)
6. **Rooms carry addressing and atomicity, never a concurrency primitive.** No room-scoped write lock, no room
   turn policy. Write coordination is keyed on the _resource_ (a containment relation over paths), because
   tree-sharing is the measured collision. (ADR `260726-170125:55-56`)
7. **The room is a projection surface for state owned elsewhere.** "Anything a room appears to own that
   outlives the conversation is owned somewhere else." (ADR `260726-170125:57`)
8. **Persisted author identity is an opaque `authorId` resolved through a natural key**; for an agent that key
   is its `agentPath`, never its manifest ULID. Mint-on-first-use. (ADR `260726-170126:28`)
9. **The room path carries its own cascade guard (depth + ancestry) plus a posture-independent two-ceiling
   turn budget** — not the relay's budget envelope, and room fan-out never rides the relay. A refused trigger
   lands a durable, plain-language room-log entry. (ADR `260726-170127:37-46,66-79`)
10. **"Channel" means a conversation; Relay's external adapters are "Integrations"; "Connection" keeps meaning
    network connectivity.** Supersedes ADR-0224. Wire data (`ChannelTypeSchema`, `channelType`,
    `origin: 'channel'`) does **not** change. (ADR `260726-193526:28,38`)
11. **The community server never executes a member's agent.** No hosted compute; the community holds the
    conversation only. "Someone will eventually propose running 'just a small agent' on the community server…
    That is the boundary eroding, and it should be refused or promoted to product 3 explicitly, never allowed
    in as an exception." (ADR `260727-184933:44,66`)
12. **Presence follows the install.** Members and their agents are offline when their machine is off; v1 does
    not queue and does not promise a later reply. (ADR `260727-184933:48`)
13. **Hosted DorkOS is three separable products**, and (1) is already shipped. (ADR `260727-184933:36-40`)
14. **Aggregation across backends degrades per backend with `warnings[]`, never a failed request.** (ADR-0310,
    applied at `community-adapter/02-specification.md:567`)
15. **A session binds to a runtime at first write, forever.** (ADR-0255 — the reason a room cannot be a session)
16. **Capability differences are structured declarations, not a flat `features` bag.** (ADR-0256, the precedent
    `roles` follows)
17. **The action's tier decides the gate; identity only caps it.** Anonymous callers are a first-class gated
    case. (ADR `260725-133220`)
18. **In-session agent identity comes from the working directory, not a presented token** — an assertion about
    the process, explicitly _not_ a credential check. (ADR `260726-022251`)

### From `specs/community-server` D1–D9 (inherited by `community-adapter` as LOCKED, "do not relitigate")

19. **D1** — Postgres on the community server; SQLite stays local. Source-of-truth ↔ cache, not two copies.
    Rejected: Postgres everywhere; SQLite everywhere. (`community-server/01-ideation.md:45-55`)
20. **D2** — The `CommunityAdapter` is **server-side**; the client's `Transport` is unchanged. Four reasons:
    one render path, keys never touch the browser, an established twice-over pattern with conformance suites,
    and ADR-0310 already solved aggregation. Rejected: a client-side `CommunityConnector`. (`:57-82`)
21. **D3** — A remote member is filed under the community's own opaque member id. **Zero user-facing keys, in
    every path.** (`:84-92`)
22. **D4** — `apps/community` is its own self-hostable app. (`:94-100`)
23. **D5** — Build order: spike → interface → local → **Buzz read-only** → `apps/community`. Buzz is second and
    read-only deliberately: "An interface with one implementation is a fake abstraction," and read-only
    "forces `canPost: false` to exist from day one." (`:102-112`)
24. **D6** — **Your own install stays single-user, forever.** The `FORBIDDEN`-on-second-signup hook stays
    permanently; all multi-user lives in `apps/community`. (`:129-144`)
25. **D7** — Community roles are `owner` / `admin` / `member`. Deliberately not a permission system. (`:146-152`)
26. **D8** — A member adds their own agents, no approval step; the agent gets its own vouched identity;
    removing the human removes their agents; capability never flows owner → agent; admins can eject an agent
    without removing its owner; **quotas aggregate per owner**. (`:154-164`)
27. **D9** — promoted to ADR `260727-184933`. (`:166-174`)
28. **Federation is out of scope.** A community is authoritative for itself. (`:223`)

### From `specs/community-adapter/02-specification.md` (frozen for DECOMPOSE)

> **Amended 2026-07-28.** `specs/community-adapter/02-specification.md` was amended that day (all nine
> of its Open Questions resolved; the `resume` capability and `signals: 'receive'` removed), so every
> `:<line>` anchor into that file below predates the edit and no longer lands on the content it names.
> The quoted text and the claims are still accurate; only the anchors moved. Re-derive a line number
> before relying on one. Deliberately not renumbered: this is a living document and the anchors would
> rot again on its next edit.

29. **Every room reference is `(community, roomId)`.** `CommunityRef` is opaque, branded, **minted locally at
    configure time and never supplied by a remote**. `LOCAL_COMMUNITY = 'local'` is the reserved ref for this
    machine's SQLite rooms. **One adapter instance serves exactly one community** — joining two Buzz
    communities means two adapters over two hosts. (`:104-119`, `:63`)
30. **The cursor is opaque, adapter-minted, community-scoped, and self-identifying.** Four rules: only the
    minting adapter interprets it; it must reject one minted for a different room/community/epoch; **resume is
    gap-free or it throws eagerly at call time — there is no best-effort**; every entry carries the cursor that
    resumes after it. (`:428-441`)
31. **Order is the adapter's emission order; `createdAt` is for display, never sorting. Dedupe is by entry
    `id`, never by cursor.** (`:444-445`)
32. **Exhaustion is declared, never inferred** — `nextCursor === null` is the only authority; callers must not
    infer from `entries.length < limit`. (`:450-455`)
33. **Every method on the port is REQUIRED.** A capability-gated method whose capability is off rejects with
    `CommunityUnsupportedError` — never a silent no-op, never a partial write. Optional methods were rejected
    because "a backend [could] silently omit a surface and the compiler stays quiet." (`:66`, `:302-306`)
34. **Connection failure is TYPED on the result, never thrown.** Four statuses:
    `connected | not-admitted | unauthorized | unreachable`. `'not-admitted'` carries a **required
    plain-language `disclosure`** and is deliberately distinct from `'unauthorized'`. (`:67`, `:480-504`)
35. **Out-of-band admission is a first-class connection outcome.** "Joining a Buzz community is an admission
    event, not a connection" — an operator action with no in-protocol way to ask. (`:44`, `:504`)
36. **`listMembers` is universal — there is no `hasRoster` flag.** All three backends enumerate members; what
    differs is the _role vocabulary_. (`:61`)
37. **Roles are an adapter-declared vocabulary with one portable predicate, `administers`** (+ optional
    `isOwner`, which exactly one role may set). (`:62`, `:258-265`)
38. **`workspaceId` is NOT on the port.** It stays a local-only column beside a cached remote room. Putting a
    path on the wire is "the same privacy defect `author-registry.ts` exists to prevent." (`:64`)
39. **No credential crosses the port** — not as an argument, not on a DTO, not in `features`. Credentials
    resolve server-side from `<dorkHome>/communities/<ref>/`, mode `0700`, files `0600`, env override →
    persisted file → generate-and-persist, lax permissions **repaired and warned** rather than rejected, never
    logged. Modeled on `resolveBetterAuthSecret`. Conformance assertion U12 makes leakage mechanically
    checkable. (`:531-546`, `:653`)
40. **Nothing on the port executes an agent** — no `runTurn`, no `invokeAgent`, no session handle,
    deliberately. (`:53`, `:307-309`)
41. **A room that becomes unservable mid-subscription yields a terminal `room_closed` event on the stream** —
    never a throw, never a silent end — with `reason: 'archived' | 'access-revoked' | 'unknown'`. **An adapter
    MUST NOT guess**; `'unknown'` exists so an adapter can be honest instead of confident. (`:517`, `:706`)
42. **An unread badge is not universal.** `unreadCount` is `number | null`; `null` means "not applicable here".
    Any badge/digest/notification must gate on `readCursor === 'server'` or render nothing — **and must never
    render `0`**, because a silent room and an uncomputable room are different states. (`:617`)
43. **A room id is not a capability.** Every adapter re-checks membership on read; `ROOM_NOT_FOUND` is
    reported identically for "no such room" and "not visible to you" so a probe cannot distinguish them.
    (`:705`)
44. **The eleven capability flags** (`type`, `resume`, `roomList` + `roomListPollIntervalMs`, `roomAddressing`,
    `canPost`, `roomAdmin`, `roles`, `admission`, `invite`, `agentAdmission`, `readCursor`, `responseMode`,
    `threadDepth`, `signals`, `credential`, `features`) and the full three-backend declaration table.
    **Capabilities describe the ADAPTER, not the protocol** (`:288`). (`:127-288`)
45. **Invite scoping never silently widens.** A `community`-scoped backend given a `roomId` REFUSES; it must
    not substitute "an admin adds you" (Buzz kind:9000) — "those are different acts with different consent
    semantics." Conformance C8, "the sharpest assertion in the suite". (`:407-415`, `:669`)
46. **The conformance suite branches on declared flags, never weakens.** 15 universal + 19 branched
    assertions; the `FakeCommunityAdapter` must be written **before** the suite and must be able to declare
    every legal combination. (`:625-682`, `:719`)
47. **Not federation, not message signing, not reactions, not search, not posting to Buzz, not presence beyond
    a declared flag, not anything touching `Transport` or the client, not hosted execution.** (`:79-87`)

### From `specs/rooms/02-specification.md` (the local model)

48. **The five tables**: `authors`, `rooms`, `room_members`, `room_entries`, `room_sessions` (`:29-132`).
49. **`seq` is per-room monotonic, allocated in an `IMMEDIATE` transaction.** Not a tuning preference —
    Drizzle's default deferred transaction begins as a reader and cannot upgrade, failing
    `SQLITE_BUSY_SNAPSHOT`. "Flipping the flag should turn the test red." (`:116-118`)
50. **`POST /api/rooms/:id/entries` is trigger-only, 202**, mirroring `POST /api/sessions/:id/messages`.
    Delivery rides SSE. (`:184`)
51. **Two streams, two jobs.** `GET /api/rooms/:id/events` carries a room's entries (snapshot →
    `Last-Event-ID` replay → live, cursor `<roomId>-<epoch>-<seq>`); `GET /api/events` carries five lifecycle
    signals (`room_created`, `room_updated`, `room_member_added`, `room_member_removed`, `room_activity`).
    **Do not drive an open room's message list from global events, and do not drive the sidebar from a per-room
    subscription.** A new global event name is not done until it appears in both the broadcaster and the
    client's `GENERIC_EVENTS` allowlist. (`:207-220`)
52. **Room identity travels as a search param** (`/channels?id=…`), matching `/session?session=`. (`:299-308`)
53. **Sort DMs by recency, channels by name.** (`:503`)
54. **Palette prefixes: `#` for rooms, `@` for DMs and agents.** "A channel is addressed by its name, a DM by
    who is in it." Typing `@ana` offers both "Message Ana" and "New session with Ana". Message search is
    explicitly out of scope for the palette. (`:509-517`)
55. **`Esc` marks this room read; `Shift+Esc` marks everything read**; `alt+↑/↓` next/prev unread;
    `mod+shift+k` new DM. (`:524-529`)
56. **No "Leave" and no "Pin" on rooms.** Archive is the honest reversible verb; pinning is a deliberate
    omission. (`:483-484`)
57. **Creation must include membership** — the create flow takes a name **and** an agent selection in one pass,
    because "a channel with no agents in it does nothing." (`:574-577`)
58. **An unrecognized `/foo` is never silently swallowed and never silently sent as chat text.** It stays in
    the composer with the reason visible, before send. (`:691-695`)
59. **Rooms are out of scope for the Obsidian embed in v1**; the room Transport methods go in
    `direct/stub-methods.ts`. (`:280`, `:389`)

### From `specs/channel-workspace` and `specs/invites`

60. **A channel workspace is a git repo distributed by clone, one per channel per machine, read-only to every
    agent, with the DorkOS sidecar outside the clone.** (`channel-workspace/02-specification.md:66-78`)
61. **Channel instructions ride the turn (`systemPromptAppend`), never the file projector**; free-form hooks
    are refused; a channel can never change a member's permission posture; joining is operator-only.
    (`:21,109,174,183,186`)
62. **The pin is a commit sha; projection always reads the pinned sha, never remote `HEAD`; never mid-turn.**
    Failure degrades to stale, never to broken. (`:194-202`)
63. **Invite links are signed (HMAC-SHA-256, HKDF from the Better Auth secret), self-describing, and
    seat-limited; the role comes from the invite row, never the token.** (`invites/02-specification.md:130-245`,
    `:679`)
64. **A restricted role is enforced by a default-deny allow-list with a build-failing coverage test, not a
    permission system.** (`invites/02-specification.md:336-349`)
65. **Minting an invite requires `auth.enabled === true`**, read directly rather than through `canExpose()` so
    the `DORKOS_ALLOW_INSECURE_BIND` escape hatch cannot open registration. (`invites/02-specification.md:709-717`)
66. **An invite link is a bearer credential and replay is accepted by design** — binding it to an email would
    require an email to preview, which the experience contract refuses. Mitigations: 1 seat, 7-day expiry,
    instant revocation, a `member_joined` notice naming who actually joined. (`invites/02-specification.md:691-697`)
67. **There is no per-member budget.** A member posting in a room with an agent spends the owner's model quota
    and runs that agent with the server process's filesystem access. "Inviting someone is a statement of trust
    in that person, and the docs say exactly that, in those words, on the page where the owner clicks Invite."
    (`invites/02-specification.md:723-735`)
68. **The local server does not gain social sign-in** — OAuth needs a stable public origin, which only
    `apps/site` and `apps/community` have. (`invites/02-specification.md:480-508`, `:822`)

### From `specs/multi-participant-message-list` (the render layer)

69. **The right-aligned user bubble is removed; every author renders in the left gutter.** Right-alignment
    encodes "me vs them" and cannot express N participants. (`:49`)
70. **Grouping breaks on author change, a >5-minute gap, or a day boundary** — never on role. (`:57`)
71. **`author` is a client-derived view model, NOT a wire-schema field** in phase 1; the resolver is the seam.
    (`:51`) — partially superseded, see §6.3.
72. **Assistant identity resolves agent-first, runtime-second. Never render a bare "Assistant".** (`:53`)

---

## 6. Contradictions and drift

### 6.1 Threads: child room (ADR) vs entry-level relation (port) — the biggest one

ADR `260726-170125:29` and `rooms/02-specification.md:71` say **a thread is a child room**.
`community-adapter/02-specification.md:459` says:

> "ADR `260726-170125` decided 'a thread is a child room' for our storage, and that decision stands unchanged
> for local storage. What this spec establishes is narrower and does not contradict it: **at the port, a
> thread is a relation between entries, and `listRooms` never returns one.**"

The spec is careful, but the _consequence_ is a genuine behavioral divergence it names itself (`:475`):

> "The local adapter's `listRooms` must filter `kind === 'thread'` out, which is a real divergence from
> today's `RoomService.listRooms` (which returns thread rooms as `RoomSummary`s). Threads become reachable
> only through `listEntries(roomId, { thread })`… **This is the largest single consequence of the design and
> it is deliberate.**"

And it is Open Question 1 (`:728`): whether that breaks the cockpit's thread pane is **unresolved**, because
the client's thread surfaces have not been traced. Also note the ceiling mismatch: local is `threadDepth: 1`,
Buzz is `'unbounded'` (`:284`) — so _depth_ is a declared capability while _storage shape_ is not.

### 6.2 Read cursor: three successive answers

- `multi-participant-message-list:55` (D4): **client-local `localStorage`** per session.
- `rooms/02-specification.md:314`: the unread divider reads `lastReadSeq` **from the membership** — "this is
  what resolves D4 of `multi-participant-message-list` from 'client-local for phase 1' to the real cursor."
- `community-adapter/02-specification.md:212`: three-valued at the port —
  `server | client-opaque | none`, and on two of three backends `unreadCount` is `null` forever.

Not a contradiction (each supersedes the last explicitly), but a reader landing on the older doc will get the
wrong answer. The `multi-participant` spec is still `specified` and carries no supersede banner.

### 6.3 Author identity: view model vs persisted id

`multi-participant-message-list:51` (D2) keeps `MessageAuthor` a **client-derived view model** off
`ctx.agent.id` (the manifest ULID). ADR `260726-170126` then rules the ULID unusable as a persisted key. Both
now coexist by design, and the ADR flags it as the predictable failure (`:57`): "Two ids for one agent now
coexist — the display path and the persistence path — and a future change that persists the view model would
reintroduce the whole bug." `rooms/02-specification.md:318` restates the guard: "**Do not persist the view
model, and do not feed `ctx.agent.id` into a room column.**"

### 6.4 Roles: two vs three

`invites/02-specification.md:308-314` specifies exactly **two** roles, `owner` and `member`, with a full
May/May-not enumeration. D7 (`community-server/01-ideation.md:146-152`) specifies **three**:
`owner` / `admin` / `member`. The invites banner concedes this (`:32`): "**Superseded by D7** — the community
server has `owner` / `admin` (many) / `member`, not two roles. §3.2's May/May-not lists need re-deciding
against three roles." **So the §3.2 permission enumeration is stale and must be redone.**

### 6.5 The invites spec's own title is wrong

`invites/02-specification.md:8` is "Invites — a second person on one install"; `:22-26` says the title is
therefore wrong because D6 made the local install single-user forever. Sections still valid, but **read
`apps/community` wherever it says `apps/server`** (`:30`). §2 (reopening local registration) is **deleted**;
§3.3/§14.4D/§16-Phase-1's `roleGate` and `member-routes.ts` are **not built, deliberately**.

### 6.6 "Membership is about agents" vs humans-as-members

`rooms/02-specification.md:661-669` (§15.2) states:

> "In DorkOS the operator is not a member of a room — they _are_ the room's other side. **Membership is about
> agents.** Every membership verb therefore takes an agent, and there is no verb for the person."

That is squarely at odds with the rest of the corpus. `room_members` holds `authorId` of any kind
(`:75-81`); the client locates the viewer as `members.find(m => m.author.kind === 'human')`
(`invites/02-specification.md:440`); `invites` §4.5 adds `viewerAuthorId` precisely because two humans will
both be members; and D7/D8 make humans first-class community members with roles. §15.2's framing holds only
for the single-player local case and **breaks the moment a community exists.** Any new design should treat
§15.2 as a local-cockpit UI simplification, not a model statement.

### 6.7 D5's own falsified prose, corrected in place

`community-server/01-ideation.md:114` carries an unusual in-place erratum: "**'no membership' and
`hasRoster: false` were wrong, and contradicted the spike this paragraph cites.**" Buzz _does_ serve a
per-channel roster with roles; read cursors are `client-opaque`, not absent. The lesson recorded next to it
(`:116`): "this paragraph was written before the spike and never revisited after it, so a pre-spike belief
survived in prose next to a citation of the evidence that falsified it." Worth checking any older claim about
Buzz against `community-adapter/02-specification.md`'s table (`:270-286`) rather than D5's prose.

### 6.8 `channel-workspace` Open Question 4 is now answered but the spec still lists it as open

`channel-workspace/02-specification.md:266` still records the "Channels" naming collision as unresolved and
says "**It must be decided before any of this reaches user-facing copy.**" It _was_ decided ~3 hours later the
same day by ADR `260726-193526` (channel-workspace id `260726-162747` at 16:27; the ADR at 19:35). The spec
was never updated. Note also that `channel-workspace` uses "channel" for the _room_ meaning throughout, so it
is on the right side of the rename.

### 6.9 `channel-workspace` Open Question 1 vs `rooms.workspaceId`

`channel-workspace:262`: "Who owns the channel↔repo binding once the room model lands? This spec puts it in a
local sidecar because there is no room entity yet." The room entity now exists and carries `workspaceId`
(`rooms/02-specification.md:60`), but `rooms` §9 puts the behavior explicitly out of scope (`:384`), and
`community-adapter` keeps `workspaceId` off the wire entirely (`:64`). So the migration the OQ anticipates is
still unwritten — three specs each punt it to another.

### 6.10 `community-server` §5 understated the work; `invites` found it

`invites/02-specification.md:802-804` records: "community-server §5 understates Track B. It says 'the schema
is already multi-user-capable; the hook, an invite-token table, and a second role are what's missing.' Three
shipped authorization sites and two client call sites are also missing." `community-server:205-211` was then
amended in place to say so.

---

## 7. The two meanings of "channel" — and how they were separated

### 7.1 The rename (settled)

ADR `260726-193526` — **accepted, supersedes ADR-0224**:

> "We will use **'Channel'** for an in-cockpit conversation and **'Integration'** for Relay's external
> adapters. 'Connection' is left alone and keeps meaning network connectivity." (`:28`)

Why "Connection" was rejected as the new name for integrations (`:24`): `ConnectionStatusBanner`,
`ConnectionItem` ("Connection lost"), `use-sse-connection.ts`, `SessionInspector`'s "Connection" row,
`status-bar-registry.ts:374`, `TestStep.tsx` all mean _is the socket up_, and the status bar is always
visible, so "Connection lost" beside a "Connections" tab would read as a dropped Telegram integration.

Why "Integration" (`:30`): `docs/integrations/building-relay-adapters.mdx` has been filing relay adapters
under Integrations all along — this aligns the UI to a name the project already picked.

**Wire data does not change** (`:38`): `ChannelTypeSchema` (`'dm' | 'group' | 'channel' | 'thread'`),
`channelType`, and `origin: 'channel'` keep their values because they name the _remote surface kind_ inside
Slack or Discord.

`rooms/02-specification.md:322-352` is the mechanical rename plan (R0/DOR-523), with an explicit ordering
constraint: **it must land before the sidebar section does** — "two 'Channels' in one product, one of them a
badge inside the sidebar, is a UX defect on its own" (`:324`). The table at `:332-347` enumerates every file.
Excluded from the rename: generated `openapi.json`, shipped changelog entries, `ChannelTypeSchema`'s "Channel
Type" label in `BindingDialog.tsx`.

### 7.2 Older specs use the OLD meaning

Everything in the `channels-and-agent-adapters` / `adapter-agent-routing` / `agent-channels-tab-*` /
`channel-sender-identity` family predates the rename and means _external integration_. Cross-check any claim
from them before applying it to rooms.

_(Detail from the parallel older-spec sweep is folded into §8.)_

---

### 6.11 The shipped docs say TWO room kinds; the spec and the shipped API say THREE

`docs/concepts/rooms.mdx:13-14`: "DorkOS has two kinds: channels and direct messages." `docs/glossary.mdx:70-72`:
"Room is DorkOS's umbrella term for channels and direct messages." **Threads are never mentioned in either
file** — not in prose, not in the Good-to-know section, not in the REST table.

Meanwhile: `specs/rooms/02-specification.md:17` says "Three kinds: `channel`, `dm`, `thread`", and the shipped
API documents the third kind fully — `RoomKind` enum `["channel","dm","thread"]`
(`docs/api/openapi.json:4979-4984`), a dedicated `POST /api/rooms/{id}/threads` with its own generated page
(`docs/api/api/rooms/id/threads/post.mdx`), `parentId` "Non-null exactly when kind is 'thread'"
(`openapi.json:5043`), and thread response-mode inheritance (`openapi.json:5158`). Implementation confirmed at
`apps/server/src/routes/rooms.ts:208-224`.

Likely cause rather than accident: `rooms/02-specification.md:405` phases richer thread UX as **R4
(DOR-527)**, after R3b — so the primitive shipped but the experience did not. But the doc carries **no
"threads aren't covered here yet" note**, unlike the channel-membership gap which _is_ flagged in a Callout
(`rooms.mdx:66-71`). This is the most load-bearing doc contradiction found.

### 6.12 "Community" is already a heavily loaded word in shipped docs

In `docs/`, "community" means the **marketplace/package ecosystem** — the `dorkos-community` GitHub org,
`docs/marketplace/index.mdx`, `publishing.mdx`, `shapes.mdx`, `docs/integrations/extensions.mdx`, and
Obsidian's "Community Plugins" store. **Zero references to the multi-user community-server concept** (correct,
since it is unshipped — the demo-claim gate). But the collision is coming: the new meaning is
`apps/community`, a roster of humans, while the shipped meaning is a package registry. Worth disambiguating
before the new one reaches user-facing copy — the same mistake the "Channel" rename had to fix twice.

### 6.13 Multi-agent-per-external-channel was already allowed, with no arbitration

`adapter-agent-routing/02-specification.md:19,48` locks "each adapter instance maps 1:1 to an agent" and
makes many-to-many a Non-Goal. But `agent-channels-tab-03-functionality/02-specification.md:92` says: "If
multiple agents are bound to the same channel, each card shows its own view of the same 'last received'
timestamp — we do not try to show 'last received by anyone'." So the 1:1 constraint is **per binding**, not a
system-wide cap of one agent per external channel, and **no arbitration or dedup for concurrent replies from
multiple bound agents is specified anywhere**. That is the same non-decision the rooms spec makes explicitly
(`rooms/02-specification.md:241`) — arrived at twice, independently, five months apart.

---

## 8. Notes from the older corpus and the docs sweep

### 8.1 The older "channel" corpus — confirmed: external messaging, never a room

Verified across all ten specs. **The concept "room" as an internal multi-participant chat space does not
appear anywhere in that corpus.** Three distinct senses of the word coexist there:

- **Sense A (dominant, product/UX):** a configured external integration — a Slack workspace, a Telegram bot,
  a webhook — that an agent can be _bound_ to. Coined by `channels-and-agent-adapters` as a rename of "Relay
  Adapter"; its own justification is "The industry uses 'Channels' for Slack, Telegram, webhook endpoints"
  (`channels-and-agent-adapters/02-specification.md:22`).
- **Sense B (schema enum):** `ChannelTypeSchema = z.enum(['dm','group','channel','thread'])`
  (`packages/shared/src/relay-envelope-schemas.ts:26-28`) — here `'channel'` is one _sub-kind_ of remote chat
  context inside a platform. A Sense-A channel _contains_ dm/group/channel/thread sub-kinds. This is the enum
  ADR `260726-193526:38` explicitly refuses to rename.
- **Sense C (Relay pub/sub jargon, minor):** `relay.system.console` glossed as a "system broadcast channel"
  (`agent-tool-context-injection/02-specification.md:89`).

Strongest single piece of evidence for the distinction:
`agent-channels-tab-01-correctness/02-specification.md:56-58,76` — the `claude-code` runtime adapter is marked
`category: 'internal'` **precisely so the UI can distinguish it from external channels like Telegram and
Slack**, because "Users see 'Claude Code' as a connectable 'channel' in the picker, which breaks their mental
model of what a channel is."

Per-spec highlights relevant to the new design:

- **`adapter-agent-routing`** (implemented, 2026-02-28) — the `BindingRouter`/`BindingStore` foundation.
  Adapters publish to `relay.human.*`; the router resolves bindings most-specific-first on
  `adapterId`+`chatId`+`channelType` and republishes to `relay.agent.*`. "Adapters remain dumb protocol
  bridges; all routing logic is centralized" (`:19`). ADR-0046 is the accepted decision.
- **`adapter-binding-improvements`** (implemented, 2026-03-22) — encodes the adapter _instance_ id into the
  relay subject so a second Telegram bot's messages stop routing to the first's bindings
  (`:424-454`, e.g. `relay.human.telegram.my-bot.123`).
- **`channel-sender-identity`** (implemented, 260721) — the closest older analogue to room author identity.
  Sender identity rides `<relay_context>` as `Sender:` / `Chat:` lines and composes
  `originLabel = "<Platform> · <chat ?? sender>"`, where **"chat title wins (groups), sender otherwise
  (DMs)"** (`:54`). Critically: identity here is **advisory display/context only, explicitly not an
  authentication or security boundary** (`:36,92-95`, citing ADR `260721-153851`) — the same posture ADR
  `260725-133220` later generalizes. Agent-to-agent, task and A2A prompt formats stay byte-identical (`:27`).
- **`agents-first-class-entity`** (implemented, 2026-03-29) — Non-Goals lock in, for that era, "Multi-agent
  sessions (one session, multiple agents)" and "Agent-to-agent communication (handled by Relay)" (`:50-51`).
  Its "Connections" tab (`:576-582`) is the direct ancestor of the Channels/Integrations tab.
- **`agent-tool-context-injection`** (implemented) — static XML blocks documenting relay/mesh/adapter tool
  conventions to agents (ADR-0068). No chat semantics.
- **`auto-hide-tool-calls`** (implemented, 2026-02-12) — **irrelevant**; its only "visibility" hits are CSS/
  React render visibility of tool-call cards.

**Two artifact-hygiene findings worth a follow-up ticket, unrelated to design:**

- `specs/a2a-channels-interoperability/` is **not in `specs/manifest.json`**, and its own status is
  inconsistent: `00-brief.md:5` says `status: brief`, `02-specification.md:5` says "Draft", and
  `04-implementation.md:9-10` says "Status: Complete, Tasks Completed: 11/11" — with real shipped code in
  `packages/a2a-gateway/src/`. Also note the "Channels" in its title is a **fourth sense**: Anthropic's own
  "Claude Code Channels" SDK feature, which was explicitly dropped from scope (`02-specification.md:21`).
- `channel-sender-identity`'s frontmatter says `id: 260721-215837`; the manifest says `260721-215926`.

### 8.2 The docs sweep

**`docs/concepts/rooms.mdx` (from commit `6a7d398fd`) is the canonical user-facing statement**, and it matches
`rooms/02-specification.md:600-606` almost exactly:

| Concept | Doc definition                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------- |
| Session | "one conversation with one agent, tied to one project folder"; ends when the work is done (`:11,20`) |
| DM      | "who you're talking to"; one or more agents, no folder of its own; never ends (`:21`)                |
| Channel | "a topic"; any number of agents, by name; ends when you archive it (`:22`)                           |

The mental-model line ships verbatim (`:24-25`). Other locked user-facing statements:

- **Response modes** are documented as a hard four-value enum with the same trigger table
  (`rooms.mdx:130-138`), and the same seeding rule — DM seeds from the agent's own default, channel seeds
  `mention-only` (`:140-141`).
- **Mentions**: type `@` + agent name. **No autocomplete yet**; the name must match the sidebar exactly; an
  unresolvable `@name` is plain text and "nothing breaks". Resolution happens **once, at post time**, against
  the room's current roster — renaming an agent does not retroactively change an old message (`:55-56,75-78,141-143`).
- **Cascade cap** documented plainly as "3 automatic replies in a row by default", configurable, reported
  when hit, reset by a new human message (`:81-86`).
- **Visibility** documented as "You see every room; your agents don't" (`:90-91,145-149`).
- **Rooms have no folder**: agents always work in their own normal project directory, never one chosen for
  the conversation (`:27-35`).
- **A shipped gap is honestly flagged in a Callout** (`:66-71`): "There's no way yet, in the app, to add
  agents to a channel, either when you create it or afterward… Posting in an empty channel won't error, it'll
  just sit there unanswered." Workaround offered: use a group DM. (This is `rooms/02-spec` §14.2, the
  operator's sharpest finding, still open.)
- **Group DM dedupe is user-visible**: "There's no way to end up with two DMs to the same people" (`:50-51`).
- Each agent keeps **one session per room, bound on first reply**, for context continuity (`:151-156`).

**Relay / Mesh docs are a separate world.** `docs/concepts/relay.mdx`, `mesh.mdx`,
`docs/guides/agent-coordination.mdx` and `relay-messaging.mdx` **never mention room, channel (in the room
sense), or DM.** Mesh groups agents into **namespaces** by filesystem location, deny-by-default across
namespaces (`mesh.mdx:132-140`). Both carry the demo-claim caveat — `relay.mdx:110`: "Multi-agent coordination
through Relay is shipped, but we haven't verified every agent-to-agent path end to end yet." The only
cross-link is `rooms.mdx:167-169` → Mesh; nothing links back.

Minor copy bug found: `docs/guides/relay-messaging.mdx:170` says "five" built-in adapters and lists four.

**`plans/` is all pre-rooms provenance.** `2026-02-24-mesh-design.md`, `2026-02-24-relay-design.md`,
`2026-02-27-relay-conversation-view-design.md`, `2026-02-28-telegram-adapter-investigation.md` are all marked
`Provenance` in `plans/INDEX.md:26-30` — superseded but kept because ~9-20 implemented specs cite them.
**None uses "room", "channel", or "DM"**; the rooms vocabulary is entirely new as of July 2026. Same for
`plans/mesh-specs/` (5 files) and `plans/relay-specs/` (7 files) — grepped, zero hits. One terminology drift
to be aware of when reading them: they call the scheduler **"Pulse"**; shipped docs call it "Tasks" / "Task
Scheduler". `plans/2026-02-27-relay-conversation-view-design.md` is about the Relay **debugging panel's**
message grouping, not the chat surface — do not mistake it for room-view prior art.

**Research prior art** (filenames only, not read here): `research/20260724_multi-user-communities.md`,
`research/20260727_agent-identity-in-communities.md`, `research/20260727_multi-user-review-exchange.md`,
`research/20260727_buzz-protocol-capability-spike.md`, `research/20260727_q3-contention-findings.md`,
`research/20260727_chat-navigation-quick-switcher-patterns.md`. The first three are the direct antecedents of
the community program; the Buzz spike is what the `CommunityAdapter` flag set is derived from.

---

## 9. Open questions the specs explicitly leave unresolved

Quoted, with the spec's own framing preserved — several are flagged as "decide before X".

### From `specs/community-adapter/02-specification.md` §Open Questions (`:724-736`)

Preamble: _"Every one of these is a genuine uncertainty, flagged rather than papered over."_

> **All nine were answered on 2026-07-28** and that section is now "Decisions resolved after SPECIFY"
> in the spec. Read the nine below as the questions that were asked, not as open work; the answers,
> and which of them changed the contract, are in the spec's own section. The `:<line>` anchors here
> predate the amendment.

1. **Threads vs. the cockpit's thread pane** (`:728`) — _"Does `listRooms` excluding threads break the
   cockpit's thread pane? … I believe the entry relation is the correct seam and that the translation is
   contained in the local adapter — but I have not traced the client's thread surfaces, and if the pane
   fetches a thread by room id in more than one place, the local-adapter ticket is larger than it looks.
   **Resolve by reading the client's thread surfaces before DECOMPOSE.**"_
2. **`unreadCount` shape** (`:729`) — _"Is `unreadCount` on `CommunityRoom` right, or should unread be a
   separate call? … **I picked the shipped shape for consistency; it is reversible and I am not confident it
   is right.**"_
3. **Agent consent to being conscripted** (`:730`) — _"Should the agent's own consent to being added to a room
   be on the port? Buzz's `channel_add_policy ∈ {anyone, owner_only, nobody}` lets the \_agent_, not the adder,
   decide who may conscript it — the natural companion to `roomMembers.responseMode` … it is much easier to
   add to `AdmitAgentInput` before three adapters exist than after. **Needs a call.**"\_
4. **Role ordering** (`:731`) — _"Does `roles` need `rank`? … If a product surface ever needs 'is this role
   above that one' (a moderation UI, a role picker), a partial order will have to be added and there is no
   obvious right answer for `Bot`. **Unresolved by design; recorded so it is a decision rather than a
   discovery.**"_
5. **`CommunityRef` derivation** (`:732`) — _"What is a `CommunityRef` made of, concretely? … A ULID is the
   safest (stable across a host rename); a normalized host is more legible … it appears in a filesystem path
   (`<dorkHome>/communities/<ref>/`), so it must be path-safe whatever it is. **Decide before Phase 3.**"_
6. **Whether `resume: 'none'` should exist** (`:733`) — _"All three backends can reach `'gap-free'` … A flag
   with no user is dead weight by AGENTS.md's own standard. I kept it because it is the flag that makes the
   refusal \_stateable_ … **A reviewer could reasonably cut it.**"\_
7. **Reactions** (`:734`) — _"Where do reactions land? Buzz has kind:7 NIP-25 and we do not … Adding
   reactions to this port now would be inventing a capability with zero implementations; leaving them out
   means a fourth mismatch surfaces when someone asks. **Deliberately deferred, not decided.**"_
8. **Foreign presence/typing** (`:735`) — _"Is `signals: 'receive'` real? … Whether we would actually surface
   another community's typing indicators before we can post there is a product question I do not know the
   answer to. **The flag is cheap; the value may be zero.**"_
9. **Learning you were removed** (`:736`) — _"How does a member's local install learn it was removed from a
   community? … a member removed while offline learns only on next connect, and their local cache holds rooms
   they can no longer read. Cache invalidation on `'not-admitted'` is the obvious answer and it is **not
   specified here.**"_

### From `specs/community-server/01-ideation.md` §7 (`:229-251`)

- OQ1 (Buzz auth for reads) — **closed**, answered yes.
- OQ2 (what `CommunityCapabilities` enumerates) — **resolved** in the adapter spec (`:59`).
- OQ3 (`workspaceId` for a remote room) — **resolved: no, it is not on the port** (`community-adapter:64`).
- OQ4 (how an agent authenticates to a remote community) — **resolved: it does not** (`community-adapter:65`).
- OQ5 (roles across disagreeing backends) — **resolved: adapter-declared vocabulary + `administers`** (`:62`).
- OQ6 (tenancy addressing) — **resolved: `(community, roomId)` everywhere** (`:63`).

So the parent's open list is fully discharged; the live uncertainty is the adapter spec's own nine.

### From `specs/invites/02-specification.md` §17 (`:763-798`)

Eleven of twelve were resolved by Dorian on 2026-07-27 (seats = 1, role name = `member`, expiry = 7 days,
`community.name` config field added, ask for a Name on join, extract `decideRegistration`, add a
`member_joined` notice, `You` kept until a second member exists). **One is still open** (`:781`):

> **"Still open — #8, member API keys.** Deliberately not decided yet. Dorian asked how Buzz handles attaching
> agents before we choose, since 'she brings her agents' is the MVP's differentiating beat and we have
> committed to zero user-facing keys."

Plus one deferred to its own spec (`:777`, #10): **removing a member** — "Account deletion, message retention,
and what she sees on her next request are a coherent unit and not this one."

And the banner's standing item (`:32`): **§3.2's May / May-not lists need re-deciding against D7's three
roles.**

### From `specs/channel-workspace/02-specification.md` §Open Questions (`:260-266`)

1. **"Who owns the channel↔repo binding once the room model lands?"** — "This spec puts it in a local sidecar
   because there is no room entity yet. When there is one, the room is the natural owner and the sidecar
   becomes a local cache of it. **Flagged so the migration is expected rather than discovered.**" (Still
   unwritten — see §6.9.)
2. **"Should a channel workspace and a marketplace package be the same artifact?"** — "Converging them … would
   pull the marketplace's trust model into the channel's … **Not settled here.**"
3. **"Can an agent be a member of a channel independently of its owner?"** — "v1 says no … If agents ever get
   independent membership, §3.6's 'joining is operator-only' **needs rewriting, not amending.**"
4. **The "Channels" naming collision** — now answered by ADR `260726-193526`; the spec was never updated.
5. **Instruction cap: hard reject or per-channel budget with priority?** — "v1 rejects and surfaces … **silent
   truncation of rules is never acceptable**, so any change here must stay visible."

### From `specs/rooms/02-specification.md`

`multi-participant-message-list:204` says "None blocking." The rooms spec has no Open Questions section —
its unresolved items are phases, not questions: **R4 (DOR-527) threads**, **R6c** (the four §13.1 defects),
**R9** (palette/unread navigation), **DOR-603** (slash commands, blocked behind R6b). The one genuinely
undesigned item it names (`:707`): the addressed form `@agent /command` in multi-agent rooms "depends on §5's
addressing work and can follow, provided the bare form in a multi-agent room **asks rather than guesses**."

### Standing residuals stated as accepted, not open

- The cascade guard's **caller-asserted identity residual** with login off (ADR `260726-170127:55-64`) — "not
  closable from the room path… The actual fix for the adversary is login being enabled."
- **Cross-room ancestry does not carry** (ADR `260726-170127:127-134`).
- **No per-member budget** (`invites:735`).
- **Invite links are bearer credentials; replay is accepted** (`invites:695`).
- **The hard-process-death gap** — a turn with no `turn_end` is a message another member never sees and
  cannot know they missed (ADR `260726-170125:78`).
- **A moved agent directory silently splits into two authors** (ADR `260726-170126:54`).
