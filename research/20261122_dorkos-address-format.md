---
title: 'One address and id format for DorkOS: dork: references, addresses, links, email and signing'
date: 2026-11-22
type: internal-architecture
status: active
tags: [addresses, identity, handles, email, provenance, links, spaces, work-graph, dor-4966]
---

# One address and id format for DorkOS

**Status:** design decided 2026-11-22 (§12), docs only. Nothing here is built by this report. Decision record: ADR [261122-124821](../decisions/261122-124821-one-dork-reference-ids-for-machines-addresses-for-people.md) (proposed). Spec delta: `specs/conversation-model/02-specification.md` §6 (proposed, same PR). Work-graph parent: DOR-4966.
**Asked by:** Dorian, 2026-11-22 06:34 CT, #proj-dork-architecture.
**Anchor:** `origin/main` @ `cfaef8831f` (v0.140.1). Paths below were read on that commit or the one before it; symbols are named so a moved line still finds its home. Nothing was run.
**Private material:** the DorkOS Cloud repo was read for how it identifies accounts, orgs and seats. This report states only what the public wire contract (`packages/cloud-api`) and the public specs already say. No private path, hostname, price or plan name appears here.

## 1. The answer in one screen

Dorian asked for one address or id format that can:

1. route an inbound email to the right chat;
2. sign PRs, Linear comments and other outward writes so we know which space, host, agent and chat they came from;
3. link to one specific DorkOS chat;
4. name a room, a conversation or an agent without naming a chat.

**The pick: one scheme, `dork:`, with two shapes.**

| Shape                 | Looks like                                 | For                                                                                    | Changes when                                                   |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Reference** (by id) | `dork:chat:7c1e4b2a-9f3d-4e8b-a6c5-…`      | machines: storage, links, signing, the work graph. Every DorkOS thing has exactly one. | never                                                          |
| **Address** (by name) | `dork:acme/owl` and `dork:acme/owl/launch` | people: typing, mentions, email, the directory. Resolves to exactly one reference.     | only by retiring the old name (tombstone), never by editing it |

Everything a person sees is a rendering of one of those two:

| Rendering | Of                                                         | Example                                                                                      |
| --------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Display   | an address (`#build` renders a room, which has no address) | `owl@acme`, `owl+launch@acme`, `@owl`, `#build`                                              |
| Email     | an address                                                 | `owl.acme@<mail domain>`, `owl.acme+launch@<mail domain>`                                    |
| Link      | a reference                                                | `https://<origin>/r/dork:chat:7c1e4b2a-…`, `dorkos://r/dork:chat:7c1e4b2a-…`                 |
| Signing   | references                                                 | `<!-- agent:provenance {"v":2,"agent":"dork:agent:01KJ…","chat":"dork:chat:7c1e4b2a",…} -->` |

**Why this and not the spec's `dork://{space}/{handle}/{conversation}`:** that form names a thing by three renamable words and no id, so every link breaks on a rename and a room with ten agents has no "owner" to put in the path. It also disagrees with the Cloud contract, which already stores `dork:<org-slug>/<handle>` (no `//`) as a seat's canonical address (`packages/cloud-api/src/seats.ts`, `AddressSchema.canonical`). This report keeps that contract form as the **address** shape, adds the **reference** shape for things that have no stable name (chats, rooms, entries, hosts), and drops `//` because a reference is a name, not a location.

**Where a thing lives is never part of its id.** The origin of a link, the `space` and `host` fields of a signature, and the domain of an email carry "where". The id carries "what". That is what lets an agent move computers, a chat be resumed from another device, and a conversation span many sessions without any link breaking.

**Three risks to watch** (§13): two half-built identity grammars already exist and will ship incompatible if nobody picks; chat ids are only as stable as the runtime's (Claude Code re-keys a new chat once), so the link resolver must follow the one redirect; and the current signature already leaks hostnames into trackers, so the hostname field should go before anything else lands.

**The six decisions in §12 were made on 2026-11-22**: Dorian delegated them to DorkOS Code (09:40 CT, #proj-dork-architecture), and every pick below stands as written.

## 2. What exists today

Read on `cfaef8831f` unless noted. **Two earlier attempts at this exist, and they disagree.**

| Thing                | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Where                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proposed address (A) | `dork://{space}/{handle}/{conversation}` canonical, `{handle}[+{name}]@{space}` display, `{handle}[+{name}]@{space}.{mail domain}` email, bare `{handle}@{space}` = front door. Draft. Nothing parses it.                                                                                                                                                                                                                                                           | `specs/conversation-model/02-specification.md` §6; ADR `261017-211859` (proposed), decision bullet "One address points at one conversation"                                                         |
| Built address (B)    | `dork:<org-slug>/<handle>`, the "full canonical form" of a seat's address; handles 2 to 32 chars, `[a-z0-9_-]`, no dot, "a single routing token", unique within the org; org slug = "the short name that appears in a canonical address"; the wire still allows `PATCH` of a slug.                                                                                                                                                                                  | `packages/cloud-api/src/seats.ts` (`OrgSchema`, `AddressSchema`, `HandleSchema`)                                                                                                                    |
| Agent id             | A ULID minted at registration (`monotonicFactory`), kept when a folder already has a manifest. Validated only as `string().min(1)`. `name` is an immutable kebab slug (`AGENT_NAME_REGEX`) the `@handle` derives from. Not unique by itself; the unique key is `project_path`.                                                                                                                                                                                      | `packages/mesh/src/mesh-discovery.ts`, `packages/shared/src/mesh-schemas.ts`, `packages/shared/src/validation.ts`, `packages/db/src/schema/mesh.ts`; ADR-0076 (agent ULID vs SDK UUID)              |
| Handle               | `authors.handle`, lowercase, unique per install on `lower(handle)`, released handles kept in `handle_tombstones`; derived from `agents.name` with `-2` on collision; reserved `dorkos`, `everyone`, `here`, `channel`, `room`; a look-alike (TR39 skeleton) check; only a person renames one (DOR-3156). Local grammar allows dots; the Cloud grammar does not.                                                                                                     | `packages/shared/src/handle.ts` (`HANDLE_PATTERN`), `packages/db/src/schema/rooms.ts`, `apps/server/src/services/rooms/handles/*`; authority `specs/handles/02-specification.md`                    |
| Per-space handles    | Only on space servers: `community_handles (communityId, handle)` holds people and agents in one namespace per space. A local install has one flat namespace. How the two relate is the spec's open item 1.                                                                                                                                                                                                                                                          | `apps/server/src/services/spaces/schema.ts`, `services/spaces/handles.ts`; `specs/conversation-model/02-specification.md` §6, §10                                                                   |
| Room id and name     | A ULID. Kinds `channel` and `dm`; a thread is a relation between entries. A channel slug (`ROOM_SLUG_REGEX`, up to 80) is unique only among **live** channels: archiving releases it, a rename moves it, and there is no slug tombstone. `well_known` (`team`) is unique forever. A DM is keyed by its member set. Across spaces, `RoomAddress = {community, roomId}`: "a bare room id is never sufficient".                                                        | `packages/db/src/schema/rooms.ts`, `packages/shared/src/room-schemas.ts`, `services/rooms/manage/room-updates.ts`, `packages/shared/src/community-adapter.ts`                                       |
| Chat (session) id    | A UUID. A new chat starts on a client UUID and is re-keyed once to the runtime's canonical id, with a one-way in-memory redirect (ADR-0267 and its amendment). Codex: `codex_threads` maps the DorkOS id to a thread id, first write wins. OpenCode: a deterministic UUIDv5 of the native `ses_…` id. The owning runtime is `session_metadata.runtime`, first write wins (ADR-0255). A fork is a new id.                                                            | `decisions/0267-canonical-session-id-in-url.md`, `packages/db/src/schema/codex.ts`, `services/runtimes/opencode/sessions/session-mapper.ts`, `packages/db/src/schema/sessions.ts`                   |
| Install id           | Two different ids. The **install id**: a UUID v4 in `<dorkHome>/telemetry-install-id`, minted on first read, survives as long as the data folder does; it is the audit actor `install:<id>`. The **Cloud instance id**: opaque, issued by Cloud, read from `GET /v1/session`, deliberately not persisted.                                                                                                                                                           | `apps/server/src/lib/instance-id.ts`, `services/audit/account-ids.ts`; `packages/cloud-api/src/session.ts`; `specs/cloud-instance-identity-adoption/`                                               |
| Signing              | `<!-- agent:provenance {"v":1,"harness","sessionId","account","host","surface","instanceId","resumeUrl"} -->`. Defined in the flow plugin, referenced by AGENTS.md. `host` was the machine's hostname until Flow 0.99.2 (marketplace #198), which made it a one-way hash of the install id. Public repos: `sessionId` cut to 8 chars, `resumeUrl` omitted. Nothing in this repo builds the line; the flow plugin's builder never fills `instanceId` or `resumeUrl`. | `dork-labs/marketplace` `plugins/flow/docs/provenance.md`; AGENTS.md "Signing outward writes"                                                                                                       |
| Links                | `/session?session=<id>` (`sessionPath`, `chatMarkdownLink`); rooms `/channels?id=<roomId>&thread=<entryId>&entry=<seq>&community=<ref>`; `#team` at `/`. Desktop deep links `dorkos://<host>/<path>?<query>` map to `/<host>/<path>`. The A2A base is `DORKOS_PUBLIC_URL` or host:port. Hubs will live at `<opaque id>.dorkos.app`.                                                                                                                                 | `packages/shared/src/session-link.ts`, `apps/client/src/app/route-search.ts`, `apps/desktop/src/main/navigation.ts`, `startup/steps/late-routes.ts`; ADR `261015-042933`                            |
| Relay subjects       | `relay.agent.{namespace}.{agentId}`, `relay.agent.{runtimeType}.{sessionId}`, legacy `relay.agent.{sessionId}`; tokens `[a-zA-Z0-9_-]+`, case-sensitive. `namespace` comes from the manifest or the folder name under the scan root. Humans and bridges: `relay.human.*`, `relay.bridge.*`.                                                                                                                                                                         | `packages/relay/src/lib/subjects.ts`, `packages/relay/src/subject-matcher.ts`, `packages/mesh/src/namespace-resolver.ts`                                                                            |
| A2A                  | `/.well-known/agent-card.json`, `/a2a/agents/:id/card`, `POST /a2a/agents/:id`; `:id` is the agent ULID; `provider` is unset.                                                                                                                                                                                                                                                                                                                                       | `apps/server/src/routes/a2a.ts`, `packages/a2a-gateway/src/agent-card-generator.ts`                                                                                                                 |
| Audit                | Actor `{accountId, kind, name}`; source `{surface, runtime?, sessionId?, turnId?, taskRunId?, toolCallId?}`; `spaceId`. Account ids: the agent ULID, `install:<id>`, `system`, a person's account id. "Never a path."                                                                                                                                                                                                                                               | `packages/shared/src/audit-schemas.ts`, `services/audit/account-ids.ts`                                                                                                                             |
| Spaces               | Locally a space is a community ref (`local` or a minted `CommunityRef`). A space server's `communities.id` is a UUID; its short name is "a mutable address alias, never identity", with a reserved list. The private space has no shareable address (everything-is-a-space A6). The account directory keys an agent by `(agentId, instanceId)`: "unique within that computer, not across the account".                                                              | `packages/shared/src/community-adapter.ts`, `community-admin-wire.ts`, `community-reserved-short-names.ts`; `packages/cloud-api/src/directory.ts`, `communities.ts`; `specs/everything-is-a-space/` |
| Email                | Not built. Decided 2026-10-24: Resend for inbound and outbound on one shared receiving domain, the space in the local part. `Message-ID`, `In-Reply-To`, `References` map to entry threads through a helper table. DOR-4075 (the spike) adds: the dot is the separator, `+` is mangled by some senders, names are ASCII `[a-z0-9-]`, reserved local parts, renames forward for a set time and are never reissued.                                                   | `specs/conversation-model/02-specification.md` §9; `research/20261006_email-phone-first-class.md`; DOR-4075                                                                                         |
| Work graph           | Proposed W1: one entity reference type `{kind, id, label?, url?}` with parsers for the spellings in use; W2: an append-only `work_links` edge store. No code yet.                                                                                                                                                                                                                                                                                                   | `research/20261121_architecture-target-design.md` "The work graph"; DOR-4966, DOR-4967, DOR-4968                                                                                                    |

Two facts from the table drive the design:

- **Names change; ids do not.** Handles are renamed by people (DOR-3156), channel slugs are released on archive, org slugs are still patchable on the wire, and the Cloud contract models an address as `active` or `retired`, never edited (`AddressStatusSchema`). An address made only of names cannot be a durable link.
- **Every surface already has an opaque id**, and they are all URL-safe: agent ULIDs, room ULIDs, entry ids, chat UUIDs, the install UUID, space UUIDs. The missing piece is one spelling that says which kind of id you are holding.

## 3. The identity model

### 3.1 The things, and what is stable about each

| Thing             | Reference kind            | Id today                                                       | Stable?                                          | Human name                                                                      | Lives on                                         |
| ----------------- | ------------------------- | -------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| Account (person)  | `person`                  | the account id on Cloud; none before sign-up                   | yes                                              | handle per space; display name                                                  | Cloud                                            |
| Space             | `space`                   | a community UUID on a space server; a local community ref      | yes, once minted                                 | org slug (team or personal); a hosted Space's short name                        | its server (local, hub, or shared host)          |
| Member            | (person or agent, seated) | author row (local) or `community_handles` row (space)          | the seat is stable; its handle is a name         | `@handle` per space                                                             | the space's directory                            |
| Agent             | `agent`                   | ULID in `.dork/agent.json`                                     | yes; travels with its folder                     | `name` (immutable slug); `@handle` (per space)                                  | one computer at a time; the directory says which |
| Host (computer)   | `host`                    | a one-way hash of the install id (never the install id itself) | per data folder                                  | a device name (private)                                                         | the machine                                      |
| Room/conversation | `room`                    | ULID (local) or UUID (space server)                            | yes                                              | `#slug` (channel; released on archive), `+name` (a member's named conversation) | the space that owns it                           |
| Entry             | `entry`                   | entry id, plus a `seq` within its room                         | yes                                              | none                                                                            | with its room                                    |
| Chat (session)    | `chat`                    | the DorkOS session id (UUID; canonical after one re-key)       | yes while the chat is kept; a fork is a new chat | title (renamable)                                                               | one host, one runtime                            |
| Turn              | `turn`                    | the dispatch or turn id                                        | ephemeral; only for signing and receipts         | none                                                                            | with its chat                                    |
| Runtime           | (attribute)               | `claude-code`, `codex`, `opencode`, …                          | fixed per chat (first write wins)                |                                                                                 | the chat's host                                  |

Three rules fall out of it:

1. **A reference names what, never where.** The agent ref does not change when the agent moves computers; the chat ref does not change when the chat is resumed from a phone; the room ref does not change when its space moves from a Mac to a hub.
2. **A name is an alias with a lifecycle.** It resolves to one reference; it is retired, never edited; a retired name forwards for a while and is never handed to someone else. The Cloud contract already models an address as `active` or `retired`; DOR-4075 proposes a 90-day forward for a retired mail address; the local `handle_tombstones` table keeps a released handle from being retaken but does not forward. Channel slugs and org slugs need the same treatment before they can appear in an address.
3. **Conversations are addressed; chats are only linked.** Email, mentions and `chat_send` targets name a conversation (a room) or an agent; the seat behind it decides which chat runs the turn. A chat has a reference and a link, never an address, because it is one agent's private, mortal working context (ADR `261017-211859`).

### 3.2 What "space" means in an address

The product word is "space" (private space, team space, Community). The Cloud contract has no single space noun: **addresses and seats hang off an org** (`OrgSchema`, `kind: personal | org`), and a hosted Space is a **community** inside an org (`HostedCommunitySchema.orgId`). So:

- in an **address**, `<space>` is the **org slug**: your personal org for your private space, the team's org for a team space. It is the slug the contract puts in `dork:<org-slug>/<handle>`; this report proposes that it be unique across Cloud and lock once any address exists;
- in a **reference**, `dork:space:<id>` names the room container itself: a community id, the hub's own private space, or a local install's space.

A local install with no account has no org slug. Its space still has a reference (§6.8), its agents still have references and handles, and its display forms simply drop the `@<space>` part, the way Slack drops the workspace when you are inside it.

## 4. Options compared

| Option                                                                           | Shape                                                   | Pros                                                                                                                                                                                                                               | Cons                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. URL of names** (the spec's draft)                                           | `dork://{space}/{handle}/{conversation}`                | readable; maps straight onto a display form and an email local part; no resolver needed to understand it                                                                                                                           | every segment can change (handle rename, slug patch, channel archive), so links rot or need aliases forever; a shared room has no owner to put in the path; no way to name a chat, a host or an entry; `//` promises an authority that is not there; disagrees with the Cloud contract's `dork:` form |
| **B. Typed references by id, plus addresses that resolve to them** (this report) | `dork:<kind>:<id>` and `dork:<space>/<handle>[/<name>]` | ids never change, carry no personal data, exist offline, and are what the work graph wants (`{kind, id}`); the address shape is the contract's own; one parser serves links, signing, tools and email; versionable by adding kinds | two shapes to learn; a bare reference needs a resolver to become a click or a name; the resolver needs a directory for anything not on this computer                                                                                                                                                  |
| **C. One flat opaque id with a lookup** (`/r/01J…`)                              | a single id space, kind known only to the resolver      | shortest links; one table                                                                                                                                                                                                          | every id must be minted by DorkOS, so runtime session UUIDs and space-server UUIDs need a second id each; a reader cannot tell a chat from a room without asking; no human form at all; nothing for offline readers                                                                                   |

**Pick: B.** It is the only option where a link minted today still opens in a year, where a PR comment can be routed back without a hostname, and where the Cloud contract, the work graph and the conversation model all name a thing the same way. A carries the display grammar the designer already chose; B keeps it as a rendering. C is what B degrades to for a reader that does not know the kind, and nothing more.

## 5. The format

### 5.1 Grammar

ABNF, with RFC 5234 core rules. Lowercase is by grammar for names; ids keep the case they were minted with and are compared exactly.

```abnf
dork-uri    = "dork:" ( reference / address )

reference   = kind ":" id
kind        = 1*16LOWER                     ; "space" "person" "agent" "host" "room" "entry" "chat" "turn"
id          = 1*64( ALPHA / DIGIT / "-" / "_" )

address     = space "/" handle [ "/" name ]
space       = slug                          ; the org slug; proposed: 2 to 32, unique across Cloud
handle      = alnum *30( LOWER / DIGIT / "-" / "_" ) alnum   ; HandleSchema in packages/cloud-api (no dot)
name        = alnum [ *21( LOWER / DIGIT / "-" ) alnum ]    ; a named conversation; 1 to 23; no dot, no underscore
slug        = alnum *30( LOWER / DIGIT / "-" ) alnum
alnum       = LOWER / DIGIT
LOWER       = %x61-7A
```

Renderings (not URIs; what people type and see):

```abnf
display     = handle [ "+" name ] [ "@" space ]            ; owl, owl+launch, owl+launch@acme
mention     = "@" handle [ "@" space ]                     ; @owl, @owl@acme
channel     = "#" slug [ "@" space ]                       ; #build, #build@acme   (resolves while the channel is live)
email       = handle "." space [ "+" name ] "@" mail-domain ; owl.acme+launch@<mail domain>
link        = origin "/r/" dork-uri                        ; https://<origin>/r/dork:chat:<id>
desktop     = "dorkos://r/" dork-uri                       ; dorkos://r/dork:room:<id>
```

Length rule for email: an address may be issued only if `len(handle) + 1 + len(space) <= 40`, which leaves 24 for `+name` and keeps the local part at or under 64 (RFC 5321). Today's grammars allow 32 + 32 and would not fit; the rule bites at issue time, which is also the moment this report proposes the org slug lock (decision 1 names the contract change).

**Dotted local handles.** The local grammar allows a dot (`HANDLE_PATTERN`, derived from agent names such as `144x.co`); the address grammar does not. A dotted local handle keeps working as a mention and gets no address until a dot-free handle is issued for it.

Reserved words. As handles and as the first segment of an address: RFC 2142 (`postmaster`, `abuse`, `hostmaster`, `webmaster`), `admin`, `support`, `security`, `noreply`, `no-reply`, `mailer-daemon`, `dmarc`, `dorkos`, `dork`, plus the local reserved handles (`everyone`, `here`, `channel`, `room`) and every kind word above, so `dork:chat/…` can never be read as an org called "chat". The space-server reserved short names stay as they are.

### 5.2 Kinds and their ids

| Kind     | Id                                                             | Minted by                               | Notes                                                                                                                      |
| -------- | -------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `agent`  | the agent ULID                                                 | mesh registration                       | add a real validator (`/^[0-9A-HJKMNP-TV-Z]{26}$/`, already in `session-relay.ts`) to `mesh-schemas.ts` when W1 lands      |
| `chat`   | the DorkOS session id (canonical after re-key)                 | the client, then the runtime (ADR-0267) | a retired client UUID redirects once; a fork is a new chat and the work graph records the edge                             |
| `room`   | the room id                                                    | room lifecycle; a space server          | a thread is `entry` of its root                                                                                            |
| `entry`  | the entry id                                                   | the room log                            | links add `?seq=` for scrolling; the id is the identity                                                                    |
| `space`  | a community id, or the local space id (§6.8)                   | the space server; first run locally     |                                                                                                                            |
| `host`   | a one-way hash of the install id (never the install id itself) | derived from `telemetry-install-id`     | private: never in a public repo (§9). The raw install id is the anonymous usage id and never leaves the machine (Security) |
| `person` | the account id                                                 | Cloud                                   | none before an account exists                                                                                              |
| `turn`   | the dispatch id                                                | the turn runner                         | only in signatures and delivery records; never a link                                                                      |

Outside things the work graph also refers to (a PR, a ticket, a branch, a worktree) keep their native spellings (`owner/repo#42`, `DOR-1234`) behind the same `{kind, id}` type. They are not `dork:` URIs, because DorkOS does not own their identity.

### 5.3 Resolution

- **A reference resolves at whoever holds the thing.** Your own DorkOS answers for its chats, rooms and agents. For anything else it asks its hub's account directory (`DirectoryAgent`, `DirectoryInstance`, `DirectorySpace.hostSpaceId`), which answers with the origin that holds it, or "not found".
- **An address resolves through the org's directory** on Cloud, and through `authors.handle` and `community_handles` on the server that owns the space. A retired handle resolves to its forward for the tombstone window and then to nothing.
- **"Not found" and "no access" are the same answer** to a caller who is not signed in, so a link never confirms a thing exists.
- **A bare room id is still "never sufficient" for routing** (`RoomAddressSchema`); the reference is the identity and the `space` field, link origin or email domain is the routing hint. A resolver that knows neither asks the directory.

### 5.4 Links

One route on every DorkOS origin: `GET /r/<dork-uri>`. It checks the normal session gate, resolves, and redirects to today's screen: `/session?session=<id>` for a chat, `/channels?id=<roomId>` (with `thread` and `entry` for an entry) for a room, the agent's page for an agent. On the desktop, `dorkos://r/<dork-uri>` maps to the same route through the existing `dorkos://<host>/<path>` rule. Existing links keep working; nothing is renamed.

A link is a pointer, never a key: it carries no token, and a person without access sees the same "nothing here" page whether the thing exists or not. The hub's front door checks the login before any wake (everything-is-a-space §2.8), so a hub link is the same.

### 5.5 Email

- **Addressable:** a member's front door (`owl.acme@<mail domain>`) and a member's named conversation (`owl.acme+launch@<mail domain>`). Not addressable by email in the first cut: channels, chats, entries. A channel's slug is released on archive, so it cannot carry mail until it has a tombstone.
- **Routing order on an inbound message:** (1) `In-Reply-To` or `References` naming a `Message-ID` DorkOS minted, which lands the reply in that exact conversation and thread; (2) the **envelope recipient** (never the `To:` header, which a sender writes freely), parsed as `handle "." space [ "+" name ]`; (3) a stripped `+name` (some senders mangle it) falls back to the front door; (4) anything else is dropped before any fetch, per Security's rule on DOR-4075.
- **Message-IDs DorkOS mints** carry the entry: `<dork-entry-<entryId>@<mail domain>>`. Dot-atom text allows `-` and the id characters, and the id is unique on its own.
- **The front door** is one conversation per outside sender, made on first contact (spec §6). A reply that threads into an existing conversation from a new sender (a forwarded thread) lands in that conversation as a new, marked participant; thread continuity wins over "one conversation per sender", and the sender is named on every entry.
- **Inbound is always outsider words.** SPF, DKIM and DMARC are recorded and never lift the mark (Security, DOR-4075).
- **Renames:** a retired address forwards for 90 days, then bounces with text that never names the new address, and is never reissued (the proposal and Security's rule on DOR-4075; this report adopts both).
- **Local-only installs** have no address on the shared domain. A person who brings their own mailbox (IMAP and SMTP, spec §9) owns the local part, and DorkOS routes on the threading headers alone.

### 5.6 Signing outward writes (provenance v2)

The line stays an HTML comment with JSON, one per outward write, as the flow plugin's `docs/provenance.md` defines it. Version 2 replaces the four location fields with references:

```
<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"dorkos","account":"claude5",
  "agent":"dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J",
  "chat":"dork:chat:7c1e4b2a",
  "space":"dork:space:01JD3F1W2KQ8Z0YV9N6B5T4RMA",
  "host":"dork:host:3c594f448c55cbfade7fd79a1915dab8",
  "turn":"dork:turn:01JD3F2Z7P1Q4R8S9T0U2V3W4X",
  "address":"dork:acme/owl"} -->
```

| Field                           | v1               | v2                                                                                                                                        | Public repository                                             |
| ------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `v`                             | `1`              | `2`; readers accept both and treat a missing `v` as 1                                                                                     | same                                                          |
| `agent`                         | (absent)         | the agent reference                                                                                                                       | emitted (an opaque id; a ULID reveals only its creation time) |
| `chat`                          | `sessionId`      | the chat reference                                                                                                                        | id cut to 8 chars, as `sessionId` was                         |
| `space`                         | (absent)         | the space the chat belongs to                                                                                                             | emitted (opaque)                                              |
| `host`                          | the hostname     | `dork:host:` + the first 32 hex of `sha256("dork:host:v1:" + lowercase(install id))`, as shipped in Flow 0.99.2; never the raw install id | **omitted**; the hostname is gone in every repo               |
| `turn`                          | (absent)         | optional                                                                                                                                  | omitted                                                       |
| `address`                       | (absent)         | optional, when the agent has a seat address                                                                                               | emitted; it is the agent's public name                        |
| `resumeUrl`                     | a URL            | **dropped**: any reader builds `<its own origin>/r/<chat ref>`                                                                            |                                                               |
| `instanceId`                    | the install UUID | **dropped**; the only install UUID is the anonymous usage id, and it never leaves the machine                                             |                                                               |
| `harness`, `surface`, `account` | as v1            | unchanged; `account` stays a short handle and never an email                                                                              | same                                                          |

The `host` hash is the first cut; Security's next improvement is a random secret per install that replaces the hash, so a reader can match a host without anyone being able to recompute it from the usage id.

Reader rules do not change: newest signature wins, skipping your own; a local run record outranks the line; an unparseable line is absent, never half-trusted. Two more rules make forgery pointless (§9): a signature is routing advice, never authority, and a router delivers only into chats this install holds. A cryptographic signature (`sig`, Ed25519 over the JSON without `sig`, public key in the agent card and the directory) is designed for but not built in the first cut.

### 5.7 Mentions and display

Rooms already resolve `@handle` once, at write time, against the roster, and store author ids (`.claude/rules/room-conduct.md`). Nothing changes for a mention inside one space. Across spaces, `@owl@acme` resolves through the directory, and `#build@acme` names a live channel there. The display rules in the conversation-model spec §8.6 stand: copy the display form, truncate long handles in the middle, and the picker offers `@agent › named conversation`.

### 5.8 Case, URL safety, versioning

- **Case:** names are lowercase by grammar; a mixed-case name is refused, not folded (the Cloud contract's reason: a folded token would pass validation and then fail to match its own subscription). Ids keep their minted case; ULIDs are uppercase, UUIDs lowercase.
- **URL safety:** `dork:` URIs use only `[A-Za-z0-9:/_-]`, so they go into a path, a query or a Markdown link without encoding. `#` never appears inside one; the channel sigil is a rendering only.
- **Versioning:** the scheme is the version. New kinds are added, never reinterpreted; a reader that meets an unknown kind treats the reference as opaque and still shows it. The signature carries its own `v`.
- **The kind word is fixed English**, never translated and never a product word that may change (the kind is `chat` even if the UI one day says "conversation" for it).

## 6. One example per use

### 6.1 Route an inbound email

A customer writes to `owl.acme@<mail domain>`. The envelope recipient parses to `dork:acme/owl`, which the directory resolves to `dork:agent:01KJ…` seated in `dork:space:01JD…` (the team space). The sender has no front door there yet, so one is made: `dork:room:01JD3G…`, kind `dm`, members the agent and the outside sender. The message lands as an entry authored by the outside sender, marked outsider words. The seat wakes the agent's chat for that room (`dork:chat:…`), which the person never addressed and never needs to know.

The agent replies. The reply goes out with `Message-ID: <dork-entry-01JD3G7…@<mail domain>>`. The customer answers; `In-Reply-To` names that id, so the answer lands in the same room and thread even if the customer's mail client dropped the `+name` or the agent has since been renamed.

### 6.2 Sign a PR comment

An agent's chat on a Mac comments on a public PR. It appends:

```
<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"dorkos","account":"claude5","agent":"dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J","chat":"dork:chat:7c1e4b2a","space":"dork:space:01JD3F1W2KQ8Z0YV9N6B5T4RMA"} -->
```

No hostname, no path, no email, no `host` ref. A week later a reply arrives. A reader on the same Mac prefix-matches `7c1e4b2a` against its chats, finds one, and opens `/r/dork:chat:7c1e4b2a-9f3d-4e8b-a6c5-…`. A reader elsewhere in the team asks the directory which computer holds that agent and shows "on Dorian's Mac, away since Tuesday".

### 6.3 Link to one chat

`[Address-format design lane](/r/dork:chat:7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6)` in a room post, a Linear comment or a to-do. On the Mac it opens the chat; on the desktop `dorkos://r/dork:chat:7c1e4b2a-…` does the same; from a hub page the same path opens it through the relay or says the Mac is away. The link is the same string in every place, and `/session?session=` keeps working underneath it.

### 6.4 Name a room or an agent, not a chat

- `chat_send(to: "dork:agent:01KJ…")` or `to: "@owl@acme"`: the agent, whichever chat its seat picks.
- `post_to_room(roomId: "dork:room:01JD3G…")` or `#build@acme`: the room, every member's seat.
- `owl+launch@acme`: the agent's named conversation "launch", one log however many chats have worked in it.

## 7. Scenarios

1. **An agent moves to another computer.** Its folder, and so `dork:agent:01KJ…`, travels. The directory updates `instanceId` for it; old chats stay on the old host and their references still resolve there (or say "on the old computer"); new signatures carry a different `host` ref and the same `agent` ref, so a reader sees one agent, two homes. If someone _copies_ instead of moving, two computers report the same agent id; the directory keeps the newest heartbeat as current and flags the other, and a resolver for a chat still goes to the computer that holds the chat.
2. **A chat is forked, resumed or compacted.** Resume: same id, same reference. Compaction: same id (no code renames it). Fork: a new id and a `forked_from` edge in the work graph, so "all PRs for this chat and its children" still rolls up. The one wrinkle is the first turn of a brand-new chat: the client's UUID retires in favour of the runtime's id (ADR-0267); a link copied in those two seconds hits the one-way redirect, which the `/r/` route follows. The work graph records the re-key as an alias edge so an old reference in a PR body still resolves after a restart, which the in-memory redirect alone does not guarantee.
3. **One conversation, many chats and runtimes.** A room keeps its reference for life. Seats change (a re-seat, a runtime switch, a new agent). Each entry records the chat and turn that produced it (spec §2.3), so "Show work" and the signature always point at the right chat, and email always points at the room.
4. **A room with ten agents.** The room's reference and `#build@acme` name the room. An inbound email or `@mention` wakes seats by the room's own rules. Each agent's outward write signs with its own `agent` and `chat` and the shared `space`; the `address` field tells a human reader which teammate wrote it.
5. **A handle is renamed.** The agent's reference does not change. This report proposes what the contract's `active | retired` address status implies: the handle is retired and a new one issued; the old address forwards for 90 days (DOR-4075) and is never given to anyone else (Security's rule there). Locally, a person can rename a handle today (DOR-3156) and the old one is tombstoned without forwarding. The two must agree (decision 3 in §12): an address that has been issued makes the handle write-once, and the rename screen says so.
6. **A space is renamed.** The reference does not change. This report proposes that an org slug lock once any address has been issued; the contract still allows a `PATCH` of it, which should stop (decision 1 names the contract change). A hosted Space's short name is "never identity" and already keeps resolving after a rename with a 90-day cool-off on release.
7. **A channel is archived or renamed.** Its reference and every link to it keep working. Its slug is released on archive, which is why `#build@acme` is a rendering that resolves only while the channel is live, and why channels get no email address until slugs have tombstones.
8. **Private space and team space, same agent.** One agent reference, one handle per space (`community_handles` is per space; the private space is the personal org). `owl@acme` and `owl@dorian` can be the same agent or two different ones; the directory knows. A display form inside your own space drops the `@space`.
9. **A local-only install.** No account, no org slug, no shared-domain email. References work (ids are minted locally), links work on `localhost` and over the tunnel, signatures carry `agent`, `chat` and `space` (the local space id) and that is enough to route a reply back to the same Mac. Mentions are `@owl` with no space.
10. **A thread by email.** Mapped by `Message-ID`, `In-Reply-To` and `References` in a helper table beside the log (spec §9); the entry reference is inside the id DorkOS mints, so the mapping survives a lost table. Plus-addressing is not used for threading, only as a hint a person can type.
11. **Spoofing and forgery.** A forged signature line can at most ask a router to route; the router answers only for chats it holds, treats the body as outsider words, and prefers its local run record. A forged `From:` cannot lift the outsider mark; the envelope recipient, not the `To:` header, picks the conversation. A look-alike handle is refused by grammar (ASCII only) and by the skeleton check. A cryptographic signature is the next step once keys live in the directory.
12. **Privacy in public text.** Public repositories get `agent`, `chat` (8 chars), `space`, `address` and the runtime words; never `host`, never a hostname, a path, an email, or anything from the private repo. This is the same rule AGENTS.md has today, with the one field that kept breaking it (`host` as a hostname) removed.
13. **Links never grant access.** `/r/` sits behind the session gate like every route; a link holds no token; an unauthorised reader and a missing thing get the same page. Sharing a link to someone outside the space gives them nothing.
14. **Email local part at 64.** Enforced when an address is issued (§5.1), not when a message arrives, so a too-long pair is refused once, in the UI, rather than silently dropping mail.
15. **Case.** `Owl@Acme` typed by a person is folded before lookup in the UI; a mixed-case name on the wire is refused; ids are matched exactly.
16. **A second runtime's id shape.** OpenCode's `ses_…` id is already mapped to a UUID; a future runtime whose native id does not fit `[A-Za-z0-9_-]{1,64}` gets the same treatment (a DorkOS-minted id and a mapping table), never a new escaping rule.

## 8. How A2A, MCP and Relay map onto it

- **Relay.** `relay.agent.{namespace}.{agentId}` already carries the agent reference's id; `namespace` is a folder-derived word today and becomes the space slug when spaces land (a note for the relay owner, not a change here). `relay.agent.{runtimeType}.{sessionId}` carries the chat reference's id. No subject grammar changes; a helper derives a subject from a reference.
- **A2A.** The card at `/a2a/agents/<agentId>/card` gains two fields: the `dork:agent:` reference and, when it has one, the `dork:<space>/<handle>` address. The signing public key goes in the same card when signatures land. A per-address card on Cloud, if one is built, answers for the same agent.
- **MCP tools.** `chat_send`, `post_to_room`, `read_room_history` and friends accept a `dork:` URI, a display form or today's raw id in the same `to` and `roomId` parameters, and every tool result that names a chat, room or agent includes its reference beside the title, so a link is `[Title](/r/<ref>)`. The "never show a raw id" rule stands: the reference is for the link target, the title is for the person.
- **Audit.** No schema change: `accountId` is already the agent ULID or `install:<id>`, `source.sessionId` the chat id, `spaceId` the space. A read-side helper renders them as references.
- **The work graph (DOR-4966).** W1's `{kind, id}` is this report's reference; the `dork:` URI is its canonical spelling for DorkOS-owned kinds. W2's edges gain two relations from this design: `forked_from` and `rekeyed_from`.

## 9. Privacy and safety rules, in one list

1. No hostname, file path, account email or private-repo detail in any public body. The signature's `host` becomes a reference and is omitted in public repositories.
2. Ids are opaque and carry no personal data. A ULID carries its creation time and nothing else; that is accepted.
3. A reference is identity; it is never a credential. No route grants access because a caller knows an id.
4. Inbound anything (email, a signature on a thread, a mention from another space) is outsider words until a rule says otherwise, and no header check lifts the mark.
5. Names are ASCII, lowercase, reserved-word checked and look-alike checked, and are retired rather than edited.
6. "Not found" and "no access" look the same from outside.

## 10. Migration from today's ids

Every step is additive. Nothing is renamed, no table changes shape, and old links keep working throughout.

| Step | What lands                                                                                                                                                                                                                                                                                                            | Where                                                                                    | Depends on                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------ |
| 0    | The six decisions in §12 taken (done 2026-11-22); this ADR and the §6 spec delta become the text of record when this PR merges.                                                                                                                                                                                       | `decisions/`, `specs/conversation-model/`                                                | the PR merging                       |
| 1    | `packages/shared/src/ref.ts`: parse, format and validate `dork:` references and addresses; the `{kind, id}` type; adapters from today's spellings (`/session?session=`, `/channels?id=`, claim keys, provenance v1). This **is** W1 (DOR-4967), narrowed to a grammar. A real ULID validator on agent ids.            | `packages/shared`                                                                        | step 0                               |
| 2    | `GET /r/<dork-uri>` on the server, the client route and the desktop `dorkos://r/` mapping; tool results carry references; `chatMarkdownLink` gains a `/r/` twin. `/session?session=` stays.                                                                                                                           | server routes, client router, desktop navigation, MCP tool outputs                       | step 1                               |
| 3    | Provenance v2: the flow plugin's reader accepts v1 and v2 (reader first); then emitters move; `docs/provenance.md` and AGENTS.md "Signing outward writes" updated; the hostname field retired in every emitter. A local alias table records the one re-key so an 8-char prefix in a PR body resolves after a restart. | `dork-labs/marketplace` `plugins/flow/`, AGENTS.md, `session_metadata` or the work graph | step 1                               |
| 4    | Email bridge (when DOR-4075's spike unblocks): envelope-recipient grammar, `Message-ID` minting with the entry id, the `In-Reply-To` helper table, the front door per sender, the 64-char issue rule.                                                                                                                 | the email bridge, `packages/cloud-api` for the address issue rule                        | steps 1 and 0, DOR-4075              |
| 5    | Directory: per-space handles with tombstones that forward; the host reference (the hash, never the raw install id) recorded beside the Cloud instance id; duplicate agent ids across computers flagged; the org-slug `PATCH` closed once an address exists.                                                           | `packages/cloud-api` (contract first), Cloud, B6 (DOR-2949)                              | step 0; Cloud's agreement in #dorkos |
| 6    | A2A card fields; relay helper from reference to subject; W2 edges `forked_from` and `rekeyed_from`.                                                                                                                                                                                                                   | `packages/a2a-gateway`, `packages/relay`, the work graph                                 | steps 1 and 2                        |
| 7    | Signatures (`sig`) once keys live in the directory and the agent card.                                                                                                                                                                                                                                                | later                                                                                    | step 5                               |

Linear (filed 2026-11-22): DOR-5045 (the decision ticket), DOR-5046 (the `/r/` route) and DOR-5047 (provenance v2) under DOR-4966; DOR-5048 (email routing) in the messages project, related to DOR-4075. The grammar itself is a comment on DOR-4967 (W1), not a new issue; the directory items are a comment on DOR-2949 (B6).

## 11. What this does not decide

- The relay subject grammar and the `namespace` word (relay owner).
- How the Cloud side maps its instance id to the host reference, beyond asking for both in the directory. The raw install id never leaves the machine.
- Retention of the conversation log (spec open item 3).
- Whether a hosted Space's short name ever appears in an address. Today it does not: `<space>` is the org slug.
- Anything about prices, plans or the mail supplier's limits (DOR-4075, private).

## 12. Decisions

**Decided 2026-11-22.** Dorian delegated the six calls to DorkOS Code (09:40 CT, #proj-dork-architecture: "I trust you to make the decision on the six calls"); DorkOS Code took every pick marked below, as written. The options stay for the record. Tracked on DOR-5045.

1. **The scheme word.** **(a) `dork:` (pick):** it is already the Cloud contract's canonical form, so nothing on the wire changes; the desktop keeps `dorkos://` for app navigation and opens a `dork:` URI through `dorkos://r/`. (b) `dorkos:`: one word everywhere, at the cost of a contract change to `AddressSchema.canonical` and every stored address.
2. **The named-conversation separator.** **(a) `+name` in display and email (pick):** `owl+launch@acme` and `owl.acme+launch@<mail domain>`; a sender that strips the `+` still reaches the front door, and the threading headers do the real routing. (b) A third dotted segment in email (`owl.launch.acme`): never mangled, but it changes the "one dot" rule DOR-4075 chose and makes the position of the space depend on counting dots.
3. **Handle renames.** **(a) Write-once once an address has been issued (pick):** a rename retires the handle and issues a new one, the old one forwards for 90 days and is never reissued; the local rename screen (DOR-3156) says so. Matches the contract's retire-never-edit address model. (b) Keep free local renames with tombstones and accept that addresses on paper rot.
4. **What a public PR body carries.** **(a) `agent`, `chat` (8 chars), `space`, `address` (pick):** enough to route and to tell teammates apart; the ids are opaque and the address is the agent's public name by design. (b) `agent` and `chat` only: safest, but a reader cannot tell which space without asking, and the team's own PRs lose the "who" a human can read.
5. **Cryptographic signatures.** **(a) Design for them, ship unsigned v2 now, add `sig` when the directory publishes keys (pick):** the router's rules already make a forged line harmless. (b) Hold v2 until signatures exist: the hostname keeps leaking meanwhile.
6. **The local space's id.** **(a) Mint a space id at first run, beside the install id (pick):** the space can later move into a hub as itself, and host and space stay different kinds. (b) Reuse the install id: one fewer file, but a Mac's rooms can never be re-homed without re-keying every reference.

Decided here without asking, and easy to reverse: channels have no email address in the first cut; the `host` reference never appears in a public repository; a `dork:` URI never carries a location.

## 13. Risks

1. **Two grammars ship incompatible.** The spec's `dork://` draft and the Cloud contract's `dork:` form already disagree, local handles are renamable while the contract retires an address rather than editing it, and the email spike chose the dot before the display form chose the plus. If step 0 waits, the email bridge and the Cloud directory will each pick their own answer. Mitigation: this ADR, and the two comments on DOR-4967 and DOR-2949 that point every builder at one grammar.
2. **Chat references are only as stable as the runtime's id.** Claude Code re-keys once per new chat, and the redirect is in memory. A reference copied into a PR body in the first seconds of a chat can stop resolving after a restart. Mitigation: the `/r/` route follows the redirect, and step 3 records the re-key durably (an alias edge) before any emitter writes v2 lines.
3. **The signature leaks hostnames today.** Provenance v1's `host` field has put a machine's private network name into tracker comments (seen on 2026-11-15). Mitigation: retire the hostname from emitters as the first change of step 3, before the rest of v2.
4. **The 64-character local part.** Two 32-character grammars cannot both be true for an emailable address. Mitigation: the issue-time rule in §5.1; the contract comment on `HandleSchema` already says narrowing a field is a `/v2` change, so the rule lives on address issue, not on the handle.
5. **"Never sufficient" ids.** `RoomAddressSchema` says a bare room id is ambiguous once a second community exists. The design agrees and makes the space a routing hint carried beside the id, not inside it; a consumer that drops the hint still has an identity, but must ask the directory where it lives. Every tool that accepts a bare reference needs that fallback.

## Appendix A. Proposed delta to the provenance spec (`dork-labs/marketplace`, `plugins/flow/docs/provenance.md`)

Marked proposed; lands with step 3. Readers first, emitters second.

1. **§2 The marker line.** Example becomes the v2 line in §5.6 above. Add: "Version 2 names the writer by `dork:` references; version 1 named it by a session id and a hostname. Emit v2 once the reader in front of you accepts it; accept both forever."
2. **§4 Fields.** Replace `sessionId`, `host`, `instanceId`, `resumeUrl` with `agent`, `chat`, `space`, `host` (a reference), `turn`, `address`, per the table in §5.6. `harness`, `surface`, `account`, `v` stay. State: "`host` is a reference to the install, a one-way hash, never a hostname and never the raw install id. It is omitted in a public repository."
3. **§8 Public repositories.** `chat` is cut to the first 8 characters of its id (the id, not the whole URI); `host` and `turn` are omitted; `agent`, `space` and `address` are emitted. The fail-safe direction stays: unknown visibility is public.
4. **§11 Reading it back.** Add: "A `chat` whose id prefix matches more than one local chat, or none, degrades like a missing one. A reader that holds the re-key alias table checks it before giving up."
5. **New §13 Routing is advice.** "A signature tells a router where a reply might go. It never grants a right to deliver. A router delivers only into chats its own install holds, applies the outsider-words rule to the body, and prefers its local run record."

AGENTS.md "Signing outward writes" changes in the same step: the example line, the field list, and "truncate `sessionId`" becomes "cut the `chat` id to 8 characters".

## Appendix B. Spec delta

The replacement text for `specs/conversation-model/02-specification.md` §6 is in this PR, marked **Proposed delta (2026-11-22)**. It keeps the designer's display rules (§8.6) and the front-door rule, replaces `dork://` with the two `dork:` shapes, adds the id table, and closes open item 1 (per-space handles) by pointing at the org directory and the write-once rule (decision 3, made 2026-11-22).

## Sources

- `specs/conversation-model/02-specification.md` §6, §8.6, §9, §10; ADR `261017-211859`.
- `packages/cloud-api/src/seats.ts`, `directory.ts`, `communities.ts`, `hubs.ts`, `session.ts`, `primitives.ts`.
- `packages/shared/src/handle.ts`, `room-schemas.ts`, `community-adapter.ts`, `session-link.ts`, `audit-schemas.ts`, `mesh-schemas.ts`, `validation.ts`, `session-relay.ts`.
- `packages/relay/src/lib/subjects.ts`, `packages/relay/src/subject-matcher.ts`; `packages/mesh/src/namespace-resolver.ts`, `mesh-discovery.ts`.
- `apps/server/src/lib/instance-id.ts`, `services/audit/account-ids.ts`, `routes/a2a.ts`, `services/rooms/handles/*`, `services/rooms/mentions.ts`; `apps/desktop/src/main/navigation.ts`.
- `decisions/0076-mesh-ulid-vs-sdk-uuid-dual-id-traceability.md`, `0267-canonical-session-id-in-url.md`, `261015-042933-everything-is-a-space-hubs-space-servers-and-agent-computers.md`.
- `specs/everything-is-a-space/01-ideation.md` §2.8, `02-specification.md` A6, B8; `specs/handles/02-specification.md`.
- `research/20260728_handle-systems-prior-art.md`, `20261006_email-phone-first-class.md`, `20261006_one-server-sync-publish-identity.md`, `20261121_architecture-target-design.md`.
- `dork-labs/marketplace` `plugins/flow/docs/provenance.md`.
- Linear DOR-4966 (and children DOR-4967 to DOR-4973), DOR-4075, DOR-2949, DOR-3156, DOR-2824.
