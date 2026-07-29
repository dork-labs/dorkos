---
slug: handles
id: 260728-225135
created: 2026-07-28
status: ideation
---

# Handles — one addressable name for every author in a room

**Slug:** handles
**Author:** Claude (directed by Dorian), IDEATE stage
**Date:** 2026-07-28
**Research basis:** `research/20260728_handle-systems-prior-art.md` (Slack, Discord, Matrix, GitHub, Buzz @ `55a3ed7b`)
**Tracker:** **DOR-675** (Phase 1) · **DOR-676** (Phase 2) · **DOR-677** (Phase 3)
**Follows:** DOR-631 (`3f4b8f036`), the `@` mention picker, which is what exposed this.

---

## 1) Intent & Assumptions

### Task brief

DorkOS rooms host people and agents on one durable stream. The `@` mention picker shipped and worked, and in working it made a gap visible: **there is no handle.** No author — human, agent or system — has a name that is guaranteed typeable, guaranteed unique, and guaranteed to address them. `authors` has an opaque ULID, a `kind`, a server-side `natural_key` and a `display_name` its own doc comment disqualifies from ever being a key (`packages/db/src/schema/rooms.ts:27-29`). The human is called `'You'`. Seven of the fifty-two agents on this machine have a space in their name and cannot be addressed by any string at all.

Add one: `authors.handle`.

### The argument this whole document turns on

Slack looked at this exact problem and **removed** the handle. `<@username>` stopped functioning on 2018-09-12; mentions are `<@U012AB3CD>` id tokens; display names are explicitly not unique; even the id-plus-cached-label form `<@W123|bronte>` is deprecated. Collisions are handled by showing more information on hover, not by enforcing uniqueness.

That is a coherent, well-reasoned design, and **we cannot copy it, because Slack has no non-human authors composing message text.**

Every mention that reaches Slack's API was written by something that already knew the id: a person using the composer's picker, or an app formatting a token from an id it holds. DorkOS has four writers that cannot do either:

| Writer                       | What it writes                                                                               | Verified at                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| An agent's turn text in a DM | free-form model output, collected off the session projector and posted whole                 | `room-turn-runner.ts:16-21`; `specs/room-participation/02-specification.md` §10.2     |
| `post_to_room` (RP6)         | a `text` argument, routed through `RoomService.post` so it "inherits the mention resolution" | `specs/room-participation/02-specification.md` §10.2                                  |
| The external `/mcp` server   | the same tool, reached by Codex and OpenCode users, since `supportsMcp` is `false` for both  | `runtimes/codex/runtime-constants.ts:39`, `runtimes/opencode/runtime-constants.ts:40` |
| Relay adapters               | inbound text from Slack, Telegram and the rest                                               | `packages/relay/src/adapters/`                                                        |

**A picker cannot be the only writer of a mention here, so the string has to work on its own.** Slack's conclusion rests on a premise we do not share, so its evidence is silent on our question. That is the spine.

And it is not hypothetical. We already hand an agent an address and ask it to use one. `buildRoomContext` computes a per-member `handle` (`room-context.ts:143-175`); `room-context-block.ts:181-187` renders it as `@handle (person)` / `@handle (agent)` and, at `:228`, `You are @<handle>.`; the shared schema describes the field as _"What an `@mention` resolves against"_ (`packages/shared/src/additional-context.ts:130`). For an agent that value is `agents.name`, which for seven agents contains a space, which `MENTION_PATTERN` truncates at (`mentions.ts:36`). The file that computes it already states the invariant it is breaking:

> _"A handle the agent cannot be addressed by would be worse than no handle: it invites a message that reaches nobody."_ — `room-context.ts:290-292`

The invariant is right. Nothing enforces it, because the thing that would — a handle guaranteed typeable — does not exist.

### Assumptions

- **Write-time mention resolution stays.** `RoomService.post` resolves `@name` once against the roster and stores author ids on the entry (`room-service.ts:587`, `packages/db/src/schema/rooms.ts:207`). Renaming is therefore already safe, and nothing in this work may weaken that.
- **The opaque `authorId` remains the only identifier on the wire for attribution.** A handle is an _address_, never a key. Everything that stores who said what keeps storing the ULID.
- **`bindOwner` is the account path and is already built** (`author-registry.ts:297-317`). This work adds a field to an author; it does not touch how an author becomes an account.
- **Single-user for now.** ADR `260727-184933` D6 keeps registration closed after the first account, so the human population of a local install is one. The design must not _depend_ on that, since `specs/community-server` and `specs/invites` both end it.
- **~50 entities per install, not ~10^8.** Every scale-derived argument below is checked against this number.

### Out of scope

- **Renaming an agent, or the agent-creation UI.** `agents.name` and `agents.displayName` keep their present meanings. This spec adds a handle to the _author_, which is a different table with a different lifecycle.
- **Communities and remote members.** `specs/community-adapter` owns how a remote author's identity arrives. A handle scoped to this install is the honest v1; §6 D6 records what makes it extensible.
- **Fixing `mentions.ts:28-35`.** The research falsifies two sentences in that comment. Correcting them is a one-line follow-up ticket; doing it here would make a documentation branch a code branch.
- **Reactions, message editing, search.** Untouched.
- **An ADR.** The decisions here are product and schema shape. §7 records which two would be extracted later if they prove contentious.

---

## 2) Pre-reading Log

Everything below was opened at `042f89dae`.

- `packages/db/src/schema/rooms.ts:30-65` — the `authors` table. Six meaningful columns, unique on `(kind, natural_key)` at `:64`. **No handle.** `display_name` is documented as _"a render cache… never the key, and nothing may look an author up by it"_ (`:27-28`).
- `packages/db/src/schema/auth.ts:22-36` — Better Auth `user`: `id`, `name`, `email` unique, **`image`**, `role`. No handle. `image` exists and nothing reads it.
- `packages/db/src/schema/mesh.ts:4-36` — `agents.name` NOT NULL, `displayName` nullable.
- `apps/server/src/services/rooms/mentions.ts` — `MENTION_PATTERN` at `:36`, `WHOLE_HANDLE` at `:48`, `claimNames` at `:69-78` (first claimant wins), `advertisedHandle` at `:104-114`, `resolveMentions` at `:127-140`. The docstring at `:28-35` contains the two falsified sentences.
- `apps/server/src/services/rooms/author-registry.ts` — `LOCAL_HUMAN_DISPLAY_NAME = 'You'` at `:56`; `resolve` refreshes only `displayName`/`emoji`/`color` at `:149-171`; `bindOwner` rewrites `natural_key` in place at `:297-317`; `isOwner` at `:319-344`.
- `apps/server/src/services/rooms/room-roster.ts:187-215` — `candidatesFrom` and `namesFor`. An agent's names are `[agents.byPath(path)?.name, displayName]`; everyone else's is `[displayName]`.
- `apps/server/src/services/rooms/room-context.ts:143-175, 286-297` — `handleFor` returns `agents.byPath()?.name` for an agent and `displayName` for everyone else. This is what the model is shown.
- `apps/server/src/services/runtimes/shared/room-context-block.ts:176-187, 218-230` — the rendered roster lines and `You are @<handle>.`
- `packages/shared/src/untrusted-text.ts:65-77` — `sanitizeIdentity` collapses whitespace to a single space. **It does not remove spaces**, so an un-typeable handle reaches the model intact.
- `packages/shared/src/validation.ts:17, 43-57` — `AGENT_NAME_REGEX` and `slugifyAgentName`, both already tested.
- `packages/shared/src/mesh-schemas.ts:157, 415` — `AgentManifestSchema.name` is `z.string().min(1)`; `CreateAgentOptionsSchema.name` is regex-constrained. **The constraint is on one path and not the other.**
- `packages/shared/src/room-schemas.ts:140-145, 289-317` — `AuthorRef.mentionHandle` and `RoomEntry.mentions`, the latter described as _"Never re-parsed by the client."_
- `apps/client/src/layers/features/mentions/lib/mention-rows.ts:60-101` — `buildMentionRows`, which renders a handle-less member disabled with `'No @name'`.
- `apps/client/src/layers/widgets/room-view/ui/RoomEntryRow.tsx:80-82` — the body renders through `MarkdownContent` → `Streamdown`. **There is no mention chip anywhere in the client.**
- `specs/room-participation/02-specification.md` §10.1, §10.2 — RP5 (the picker, since shipped) and RP6 (`post_to_room`).
- `research/20260728_handle-systems-prior-art.md` — the survey this document argues from.

**Read-only DB.** `~/.dork/dork.db` copied to a scratch path and queried; nothing under `~/.dork` was written.

---

## 3) Codebase Map

**Primary components**

| Path                                                | Role after this work                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/db/src/schema/rooms.ts`                   | Gains `authors.handle` + a partial unique index on `lower(handle)`; gains a `handle_tombstones` table       |
| `packages/shared/src/handle.ts` (new)               | The grammar, in one place: validator, normalizer, deriver. Nothing else may define what a handle looks like |
| `packages/shared/src/room-schemas.ts`               | `AuthorRef.handle`; `mentionHandle` reconsidered (§5, option 3)                                             |
| `apps/server/src/services/rooms/author-registry.ts` | Mints and reserves handles; enforces the tombstone; refuses a taken one with a typed error                  |
| `apps/server/src/services/rooms/room-roster.ts`     | `namesFor` leads with the handle                                                                            |
| `apps/server/src/services/rooms/mentions.ts`        | Unchanged in shape. The roster it is handed becomes reliable                                                |
| `apps/server/src/services/rooms/room-context.ts`    | `handleFor` returns the real handle                                                                         |
| `apps/client/src/layers/features/mentions/`         | The picker offers a handle that always exists for a member                                                  |
| `apps/client/src/layers/widgets/room-view/`         | New: the mention chip, the hover card, the profile drawer                                                   |

**Shared dependencies:** `AuthorRegistry` is the single mint point and already the single place `(kind, naturalKey)` becomes an id; `RoomRoster.namesFor` is already documented as _"The single definition behind BOTH halves of the contract"_ (`room-roster.ts:204-215`). Both are the right seams and neither needs inventing.

**Data flow:** `.dork/agent.json` (source of truth, ADR-0043) → mesh reconciler → `agents` cache → `AuthorRegistry.resolveAgent(agentPath, …)` → `authors` row → `RoomRoster` → both `resolveMentions` (write path) and `RoomRoster.list` (picker path) and `buildRoomContext` (model path).

**Blast radius:** rooms only. Nothing in sessions, tasks, marketplace, mesh topology or relay reads `authors`.

**The one non-obvious hazard.** `AuthorRegistry.resolve` refreshes the render cache on every resolve (`:149-171`), and the reconciler rebuilds `agents` from disk every five minutes. A handle stored on `authors` and _derived_ on every resolve would be silently overwritten by whatever the manifest currently says — including a spaced name. **The handle must be written once at mint and left alone on subsequent resolves**, exactly as `naturalKey` is. That is a one-line property with a test, and it is the difference between this working and quietly regressing.

---

## 4) Research

Full survey and citations: `research/20260728_handle-systems-prior-art.md`. What decided things:

**Slack** — deprecated the handle entirely; broadcast keywords are a **separate token type** (`<!here>`, `<!subteam^ID>`), so a user may be called `here` with no collision and no blocklist. The removal does not transfer (§1). The token-type idea does, completely.

**Discord** — the migration off `username#1234`. _"More than 40% of you either don't remember your discriminator or don't even know what a discriminator is."_ _"Almost half of all friend requests fail…"_ _"Mostly because users enter an incorrect or invalid username due to a combination of missing discriminator and incorrect casing."_ Charset `[a-z0-9_.]`, 2–32, no `..`. Three layers. **And a blocklist** — `everyone`, `here`, contains-`discord` — which exists only because Discord's broadcast keywords share the `@` sigil.

**Matrix** — MXID plus a per-room display name, no third field, and no MXID rename at all. Display names are disambiguated at render time — unique name alone, otherwise `display name (@id:homeserver)` — with the spec saying this is _"in order to prevent spoofing of other users."_ Three costs: the uniqueness test is over the whole room membership, so a display-name change forces recomputation across the roster; the display-name grammar was never specified (matrix-spec #177, open); and because the test is string equality, a Cyrillic lookalike never collides and disambiguation never fires (element-web #5826, labelled `Security`).

**Matrix also mandates lowercase-only MXIDs**, for a reason it states outright: _"we do not consider it valid to have two user IDs which differ only in case."_ Two products, opposite reasoning, same conclusion. And Matrix pays for not having restricted early: a deprecated "historical" character set every client must accept forever.

**GitHub** — a renamed-away username is immediately claimable; a deleted one is held 90 days. The mitigation, "popular repository namespace retirement", retires the `OWNER/REPO` combination above 100 clones/week and explicitly not the login: _"Developers will still be able to sign up using the login of renamed or deleted accounts."_ Checkmarx documents **four** bypasses across 2021–2023, three of them races. GitHub separately prohibits reserving a username — a policy about users hoarding in a 10^8 namespace, not about a system reserving in a 50-entity one.

**Buzz** — the closest analogue, and the most instructive failure. It has the handle: `CREATE UNIQUE INDEX idx_users_nip05 ON users (community_id, lower(nip05_handle)) WHERE nip05_handle IS NOT NULL`. Case-folded, scoped, optional, with the empty-string-vs-NULL trap explicitly handled in the write path. **And neither of its `@`-mention resolvers reads it** — both match on `display_name`, with a doc comment saying duplicate names producing multiple matches is _"by design"_ and a test asserting `@alice` notifies every Alice. When two users contest a handle, the loser's is silently dropped and the profile written without it; the only trace is a `warn!`.

Two takeaways, and they are the ones that shape the acceptance criteria: **having the column is not the work**, and **a database constraint without a typed refusal is a feature the user cannot see.**

**Buzz also falsifies our own comment.** `mentions.ts:31-34` says _"no chat product resolves that well without an autocomplete that writes a delimiter"_ and _"Agent handles are already slugs."_ Buzz does exactly that — longest-first roster matching with a word-boundary check, tested on `"hello @Will Pfleger!"` — and seven of our agents have spaces. The comment's _conclusion_ survives; its two supporting sentences do not.

### Options considered

**A. Do nothing; make the picker mandatory.** Rejected on the spine: three of the four mention writers cannot open a picker.

**B. Slack's model — id tokens in the body.** The server rewrites `@Ana` to `<@01K…>` at write time; clients render from the token. Genuinely robust, and rejected for two reasons. It makes the stored body no longer what anyone typed, which costs auditability in a product whose whole premise is that you can see what your agents did. And it does not solve the writing problem at all: a model still has to produce _some_ string, and now that string has to be a ULID it was shown, which is worse than a handle on every axis (longer, unmemorable, and `additional-context.ts:125` already refuses to put ids in front of the model because it can hallucinate them).

**C. Matrix's model — disambiguate at render time, no handle.** Rejected: it is a _rendering_ answer to a _writing_ problem. It also imports the homoglyph hole and an O(room) recomputation, and gives an agent composing text nothing at all.

**D. Buzz's model — longest-first multi-word matching against display names.** Genuinely clever, and it does resolve `@Will Pfleger`. Rejected as the primary mechanism because the resolvable set becomes a function of who is in the room, and because it makes ambiguity a tiebreak policy rather than an impossibility. Worth revisiting later as a _fallback_ for legacy entries; not the foundation.

**E. Add `authors.handle`.** Recommended. A short, lowercase, unique, typeable token per author, derived for agents and asked for from humans.

---

## 5) Decision trade-offs worth arguing

### 5.1 Restrict, don't detect

The charset is `[a-z0-9._-]`, lowercase, 2–32, starting and ending on a letter or digit, no consecutive dots. **A Cyrillic `а` is not expressible, so there is no confusable class to catch.** Matrix's disambiguation is the alternative, and it is a detection mechanism with a documented `Security`-labelled hole exactly there. Detection is a filter you must keep current against an adversary; restriction is a grammar you enforce once.

The counter-argument is real: someone with a non-Latin name gets a handle that does not look like their name. **That is what `display_name` is for**, and it is unrestricted. This is exactly Discord's split — a lowercase ASCII username for addressing, an unrestricted display name for identity — and it is the reason the split exists.

### 5.2 Case-insensitive, which means lowercase-only

Discord measured wrong casing into a ~50% friend-request failure rate. Matrix reasoned to the same place from spoofing. Two products, opposite methods, one conclusion. There is no case for case sensitivity in this survey, and lowercase-only is stronger than case-insensitive matching because it removes the question rather than answering it: there is never a stored `@Ana` that someone must decide is the same as `@ana`.

### 5.3 Tombstone a freed handle to its original author, permanently

Three positions in the field:

- **GitHub:** release immediately (90 days after a deletion). Result: repojacking, a mitigation that covers only popular repos, four bypasses in two years, and races the platform must keep winning.
- **Matrix:** never free a handle, because you can never rename. Safe, and a bad choice is permanent.
- **Us:** rename freely; **the freed handle is reserved to the author who released it, permanently.**

This takes Matrix's safety without Matrix's price. The reason it is affordable is scale: in a namespace of ~50 entities, a permanent reservation costs nothing that anyone will notice, whereas at GitHub's scale it would deny a real name to a real person. **GitHub's anti-squatting policy is not a counter-argument** — it governs users hoarding names, not a system reserving one.

And the threat it closes is specific. Write-time id resolution means a rename cannot re-address old messages, which is exactly why _reuse_ is the remaining vector: `@bella-codebase` is retired, someone else claims it, and every future message addressed to the name a person remembers reaches a different entity. The system that most resembles ours in composition — Buzz, with agents writing prose — has no protection here at all.

**Cheap:** a `(handle, authorId, releasedAt)` table, checked on claim. **Reversible:** the original author reclaiming its own tombstoned handle is trivially allowed, which is the case that would otherwise be infuriating.

### 5.4 Broadcast keywords are a separate token type, not reserved names

`@here` / `@channel` / `@everyone` do not exist in DorkOS today — a grep across server, client and packages returns nothing. So this is free to decide now.

Slack's grammar puts them under a different sigil: `<@U…>` for a user, `<!here>` for a broadcast. A user may be named `here` and nothing collides. Discord shares the `@` sigil and therefore needs a blocklist — `everyone`, `here`, contains-`discord`, plus an explicitly undocumented tail ("other rules and restrictions not shared here").

**A blocklist is not one rule, it is one rule per enforcement point, forever**: the schema, the derive path, the human-facing form, the MCP tool, the client's optimistic validation. They drift. A separate token type has no such surface: a handle simply cannot be a broadcast because a broadcast is not written the way a handle is.

The cost is that whatever spelling we pick for a broadcast must not be `@word`. That is a constraint on a feature that does not exist yet, which is the cheapest kind.

### 5.5 Two layers, and the counter-argument defeats itself

Discord has three: unique username, global display name, per-guild nickname. We propose two: unique handle, display name.

The case for a per-room nickname is that a room is a context and people carry different names into different contexts. The case against is that it is a third name to keep in sync for a product whose rooms are, today, on one machine with one person in them.

**But the decisive point is that this is not a door we would have to unlock later.** `room_members` is already keyed `(roomId, authorId)` (`packages/db/src/schema/rooms.ts:148`), so a nickname is a nullable column on a table that already exists with the right key. Refusing it now costs nothing and needs no unwinding — which means the argument for adding it now has to stand on its own merit, and it does not.

### 5.6 Agents derive, humans are asked

**Agents derive**, de-colliding with a numeric suffix, editable afterwards. The obvious source is `slugifyAgentName` (`validation.ts:43-57`, already tested), and a second slugifier would need justification — **SPECIFY measured it and found the justification** (`02-specification.md` S3b/S3c): that function targets `AGENT_NAME_REGEX`, so it flattens `.` and `_` and prefixes `a-` for a leading digit, which changes four working agent addresses out of 52 on this machine. A handle-aware normalizer reading `agents.name` changes none. Discord's suffix degradation is the cautionary tale, and the caution does not apply: it came from deriving _late_ into an exhausted namespace of hundreds of millions. Ours is ~50 per install, and collisions will be near-zero. (The specific four-digits-then-six anecdote turned out to be unverified; the scale argument stands on arithmetic alone.)

**Humans are asked** — in the first-run flow, prefilled from the email localpart when an account exists, and **shown before it sticks**. The whole Discord lesson is that a handle you were assigned and never saw is a handle you cannot use when you need it: >40% didn't know their discriminator. One field, in a flow the person is already in. **SPECIFY moved this into Phase 2** (`02-specification.md` §4): deferring the capture meant shipping a derived `you` as the default, which is the very string this section calls the defect — and on a login-off install, the configuration D6 makes the norm, nothing would ever come along to replace it.

The current default is worse than any of this. The human's handle today is the string `'You'` — typeable, claimed, resolving. An agent addressing the operator writes `@You`.

### 5.7 The chip must render from the resolved id, and that needs spans

The label a reader sees should follow a rename, so the body keeps the original text and the chip renders the _current_ name of the resolved author. Buzz renders raw text and shows stale names forever.

**There is a real obstacle the brief does not name.** `RoomEntry.mentions` is a list of author ids with no positions, and its own schema says the client must never re-parse the text (`room-schemas.ts:297-299`). So the client cannot locate the `@token` to replace it. Three options:

1. **Client re-parses.** Violates the stated contract and reintroduces the drift the contract exists to prevent.
2. **Server rewrites the body to `<@id>` tokens.** Slack's model; loses the audit property (§4 option B).
3. **Server emits spans at write time** — `{ start, length, authorId }` alongside the ids, computed by the same pass that already resolves them. The client renders spans it was given and never parses anything.

Option 3 is the only one consistent with everything already decided, and it is nearly free: `roomEntries.body` is a JSON blob (`packages/db/src/schema/rooms.ts:204`), so it is a body-shape addition with no migration, degrading to plain text on entries written before it.

### 5.8 Humans get avatars, and there is no schema work

`user.image` already exists (`packages/db/src/schema/auth.ts:25`) and nothing reads it. `authors.emoji` and `authors.color` already exist as the render cache and are already refreshed on resolve. The account case needs a settings surface and an upload path, not a migration. Worth saying explicitly because "add avatars" sounds like schema work and is not.

---

## 6) Decisions

| #       | Decision                           | Choice                                                                                                                                                                                                                                                                                                       | Rationale                                                                                                                                                                                                                                |
| ------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | Where does the handle live?        | **`authors.handle`**, nullable, partial-unique on `lower(handle)` where not null; empty string coerced to NULL at the write boundary                                                                                                                                                                         | `authors` is already the one row per addressable entity, spanning humans, agents and the system. Nullable so the migration has a legal intermediate state. Buzz hit the empty-string trap and fixed it in the write path; we start there |
| **D2**  | Grammar                            | `[a-z0-9._-]`, lowercase, 2–32, **starts and ends alphanumeric**, no `..`                                                                                                                                                                                                                                    | Discord's charset, minus the parts that buy nothing. **Restrict, don't detect** (§5.1). One definition in `packages/shared/src/handle.ts`; no second copy anywhere                                                                       |
| **D3**  | Case                               | **Lowercase-only.** Input is lowercased before validation, so `@Ana` and `@ana` cannot both exist                                                                                                                                                                                                            | Discord's measured failure rate + Matrix's stated rationale (§5.2). Removes the question instead of answering it                                                                                                                         |
| **D4**  | Reuse after release                | **Tombstoned to the original author, permanently.** The original author may reclaim its own                                                                                                                                                                                                                  | Rename is already safe; reuse is the vector. GitHub releases and gets repojacked; Matrix forbids renames and can never fix a bad choice (§5.3)                                                                                           |
| **D5**  | Broadcast keywords                 | **A separate token type**, Slack-style. Never `@word`. **No blocklist**                                                                                                                                                                                                                                      | One rule at the grammar, versus one rule per enforcement point forever (§5.4)                                                                                                                                                            |
| **D6**  | Layers                             | **Two: handle + display name.** No per-room nickname                                                                                                                                                                                                                                                         | The counter-argument defeats itself — `room_members` is already keyed `(roomId, authorId)`, so adding one later is a nullable column (§5.5)                                                                                              |
| **D7**  | Who gets a handle how              | **Agents derive** from their name, de-colliding with a numeric suffix, editable after. **Humans are asked**, defaulted from the email localpart, shown before it sticks. _(Which normalizer, and from which field, is settled by measurement in `02-specification.md` S3b/S3c — not by `slugifyAgentName`.)_ | Discord's degradation was late derivation into an exhausted namespace; ours is ~50 per install. And >40% not knowing an assigned handle is what "shown before it sticks" answers (§5.6)                                                  |
| **D8**  | Mention chip                       | **Label renders from the resolved author id; the body keeps the original text.** Requires write-time **spans** on `body`                                                                                                                                                                                     | A rename should propagate to what a reader sees, without the client re-parsing what the schema forbids it to re-parse (§5.7)                                                                                                             |
| **D9**  | Human avatars                      | In scope for the UI, **out of scope for the schema**                                                                                                                                                                                                                                                         | `user.image`, `authors.emoji`, `authors.color` all already exist (§5.8)                                                                                                                                                                  |
| **D10** | Scope                              | **This install only.** No community scoping in v1                                                                                                                                                                                                                                                            | `specs/community-adapter` owns remote identity. The partial unique index takes a leading scope column later without changing the grammar or the mention path                                                                             |
| **D11** | Failure mode on a taken handle     | **A typed refusal at the write boundary**, rendered by route, MCP tool and form alike                                                                                                                                                                                                                        | Buzz enforces in the index and swallows the violation with a `warn!` nobody sees (§4). The constraint is necessary, not sufficient                                                                                                       |
| **D12** | The handle is written once at mint | `AuthorRegistry.resolve` must **not** refresh it the way it refreshes `displayName`/`emoji`/`color`                                                                                                                                                                                                          | The reconciler rebuilds `agents` from disk every five minutes; a re-derived handle would be silently overwritten by whatever the manifest says, including a spaced name (§3)                                                             |

---

## 7) What would become an ADR, and why not yet

The brief is right that none of this is architecture-significant on its own — it is product and schema shape inside one already-decided domain. Two would be extracted if they later prove contentious:

- **D4, permanent tombstoning.** It is a policy with an unbounded lifetime and a security rationale, and it disagrees with GitHub's published position. If someone proposes releasing tombstones after a window, that argument wants a record.
- **D5, broadcast keywords as a separate token type.** It constrains a feature that does not exist yet, which is exactly the kind of decision a future implementer will want the reasoning for rather than the rule.

D1–D3 and D6–D12 are ordinary schema and product choices; §6 is their record.

---

## 8) Phasing

Three phases. The first is independent of the other two and should ship first.

### Phase 1 — the agent is told an address that works (DOR-675)

**The urgent, handle-free part.** `buildRoomContext` hands an agent whatever `agents.name` says and tells it that is what a mention resolves against; for `Art Blocks Analytics` (a real agent on this machine) `MENTION_PATTERN` truncates that to `@Art`, nobody is addressed, and — because there is no mention rendering in the client at all — nothing shows that the message missed. The room-context path and the write path disagree about what a handle is, and the agent is on the losing side.

**It is latent, and that is stated rather than glossed.** All six rows `authors` currently holds resolve to a typeable handle; the seven agents whose `agents.name` contains a space have never joined a room. So this is a missing guard on a reachable path, not a live outage — one join away, for agents that already exist, with the affected population still at zero. `02-specification.md` §Background has the simulation.

Phase 1 closes that disagreement without adding a column:

- `handleFor` returns only a name that **round-trips** `MENTION_PATTERN`, and says so honestly when there is none, exactly as `advertisedHandle` already does for the picker (`mentions.ts:104-114`).
- A test pins `handleFor` and `advertisedHandle` in step over the same table of names, in the way `MENTION_PATTERN` and `WHOLE_HANDLE` are already pinned in step (`mentions.ts:38-47`).
- **When mention rendering is built, only a resolved mention renders as a chip.** Unresolved `@text` stays plain text, which is what `mentions.ts:10-11` already says should happen. This is a rule to build in from the first commit, not a bug to fix — there is no chip today.

**Correction to the brief.** The brief said unresolved text "still renders styled as a mention." It does not: the room body renders through `MarkdownContent` → `Streamdown` (`RoomEntryRow.tsx:80-82`) and a repo-wide grep finds no mention styling in the client. The urgency is real and it is one layer up — the agent is given a broken address — so Phase 1 keeps its position and changes its content.

### Phase 2 — `authors.handle` (DOR-676)

Schema, grammar module, derivation, backfill, validation, tombstones, typed refusal, and the wiring that makes `resolveMentions`, `handleFor` and the picker all read the same field (SPECIFY went further and deletes `advertisedHandle` outright — S1/S5). **The acceptance criterion is that wiring**, because Buzz shows what having the column without it looks like. (The backfill turned out to be six rows, not fifty-four: `authors` is mint-on-first-use, so only entities that have actually been in a room have a row. `02-specification.md` §4 has the count and what follows from it.)

### Phase 3 — the human surface (DOR-677)

Onboarding capture, profile editing, avatars, the hover card, the profile drawer. Slack's progressive disclosure is the right model: hover a mention for a card, click for a drawer.

---

## 9) Open questions for SPECIFY

1. Does the system author (`kind: 'system'`, display name `DorkOS`) get a handle, or is it deliberately unaddressable?
2. Handle length: 2–32 (Discord's) or shorter? Our namespace is ~50, so long handles buy nothing — but a short cap makes derived agent slugs collide more often.
3. What exactly does the de-collision suffix look like, and is a derived-and-suffixed handle flagged to the user as "you probably want to change this"?
4. Does the mention picker still need `AuthorRef.mentionHandle` once every member has a real `handle`, or do the two fields collapse into one?
5. Is a handle change rate-limited? At single-user scale, probably not — but the tombstone table grows once per change, forever.
6. Should Phase 1 emit a **notice** in the room when a post contains an `@token` that resolved to nobody, or is that too noisy?

---

## 10) Recommended next step

**SPECIFY.** The decisions in §6 are settled enough to freeze; §9 is six bounded questions, none of which changes the shape. `02-specification.md` in this directory.
