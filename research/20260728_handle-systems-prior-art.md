---
title: 'Handle systems — what Slack, Discord, Matrix, GitHub and Buzz actually enforce, and why DorkOS cannot copy Slack'
date: 2026-07-28
type: external-source-review
status: active
tags:
  [
    handles,
    identity,
    mentions,
    rooms,
    slack,
    discord,
    matrix,
    github,
    buzz,
    nostr,
    homoglyph,
    impersonation,
    dor-631,
  ]
feature_slug: handles
---

# Handle systems: prior art, and the one thing none of it accounts for

- **Date:** 2026-07-28
- **Status:** active
- **Feeds:** `specs/handles/` — DOR-675 (Phase 1), DOR-676 (Phase 2), DOR-677 (Phase 3).
- **Question:** DorkOS rooms host people and agents on one stream. The `@` mention picker shipped (DOR-631, `3f4b8f036`) and exposed that **there is no handle** — no addressable name on any author, anywhere. Five products have solved this problem differently. Which of their conclusions transfer to a room that contains non-human authors, and which do not?
- **Method:** (1) source review of DorkOS at `042f89dae`, every claim cited to `file:line` I opened; (2) source review of Block's Buzz at a pinned commit from a fresh shallow clone; (3) primary-document verification of Slack, Discord, Matrix and GitHub via official docs, changelogs and blog posts, delegated to two research agents with instructions to mark anything they could not confirm; (4) read-only SQL against this machine's `~/.dork/dork.db`.
- **DorkOS anchor:** `042f89dae` (`feat(agents): agents look up the answer in the DorkOS docs (DOR-661) (#589)`), branch `spec-handles` off `origin/main`.
- **Buzz anchor:** `55a3ed7b9217cee5b23e0a5441947dc929b2a38c` — `fix(desktop): clear stale thread new-message pill (#3411)`, 2026-07-28 16:35 -0600, `github.com/block/buzz`, branch `main`, Apache-2.0. Obtained by `git clone --depth 1` into a scratch dir; **every Buzz line number below is from that clone.** The `opensrc` checkout on this machine (`~/.opensrc/repos/github.com/block/buzz/main`) is byte-identical for five of the eight files cited and stale for three, so it was not used for citations. Shallow clone, so there is no commit history to mine for design intent.
- **DB reads:** `~/.dork/dork.db` was copied to a scratch path and queried read-only. Nothing under `~/.dork` was written.

> **Citation discipline.** No claim below rests on recollection of how a product works. Every external claim carries a primary-source URL and a quote; where a primary source could not be found, the claim is labelled **UNVERIFIED** and says so in the body, not only in the appendix. Every DorkOS and Buzz claim carries a `file:line`.

---

## Executive summary

**Five products, and the one that looks most like us is the one whose conclusion we cannot borrow.**

Slack deprecated the handle. `<@username>` stopped functioning on 2018-09-12; mentions are id tokens; display names are explicitly not unique. That is a coherent design **because every mention in Slack is written by a picker that emits an id.** It works because no author in Slack composes message text without a UI in front of them.

DorkOS has authors that do exactly that. An agent's room reply is free-form model output collected off the session projector (`room-turn-runner.ts:16-21`), the room-participation spec's RP6 turns that into an explicit `post_to_room` tool whose argument is a string (`specs/room-participation/02-specification.md`, §10.2), and the agent is handed a roster rendered as `@handle (person)` / `@handle (agent)` in its context block (`room-context-block.ts:176-187`) and asked to address people with it. **A picker cannot be the only writer of a mention here, so the string has to work on its own.** That is the whole argument for adding a handle, and Slack's evidence is silent on it because Slack never had the problem.

The rest of the field supplies the parameters:

| Product     | Handle enforced?                              | Case                     | Reuse after free                                | The failure it documents                                                                                                                 |
| ----------- | --------------------------------------------- | ------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Slack**   | No — deprecated                               | n/a                      | n/a                                             | Collisions handled by hover disclosure; broadcast keywords are a separate token type, so no blocklist                                    |
| **Discord** | Yes, unique, `[a-z0-9_.]`, 2–32               | Lowercase-only, forced   | Not established from primary sources            | Discriminators: >40% of users didn't know theirs; ~half of friend requests failed; **wrong casing named as a cause**                     |
| **Matrix**  | No third field — MXID + per-room display name | **MXID lowercase-only**  | MXID cannot be renamed, so never freed          | Display-name disambiguation is recomputed over the room and never fires on a homoglyph; the display-name grammar is still unspecified    |
| **GitHub**  | Yes, unique, global                           | Case-insensitive         | **Immediate on rename; 90 days after deletion** | Repojacking — four bypasses in two years; namespace retirement retires the `OWNER/REPO` pair, not the name                               |
| **Buzz**    | Yes, unique per community, optional           | Case-folded in the index | Not applicable (keyed to a pubkey)              | **The mention path never reads it**; duplicates are "by design"; a contested handle is dropped with a `warn!` and the user is never told |

**Buzz is the most instructive because it is the closest analogue and it fails at exactly the seam we are about to build.** It has a case-folded unique handle in the database — `CREATE UNIQUE INDEX idx_users_nip05 ON users (community_id, lower(nip05_handle)) WHERE nip05_handle IS NOT NULL` (`migrations/0001_initial_schema.sql:178-179`) — and both of its `@`-mention resolvers match on `display_name` and never consult it (`crates/buzz-sdk/src/mentions.rs:179-201`, `crates/buzz-cli/src/commands/messages.rs:128-198`). It ships a test asserting that `@alice` notifies every Alice, with a doc comment calling that "by design" (`mentions.rs:176-178, 584-596`). **Having the column is not the work. Wiring the mention path to it is the work.**

**Two claims in our own source are falsified by Buzz.** `apps/server/src/services/rooms/mentions.ts:28-35` says a multi-word mention has no good resolution — _"no chat product resolves that well without an autocomplete that writes a delimiter"_ — and that _"Agent handles are already slugs."_ Buzz resolves multi-word mentions with longest-first roster matching plus a word-boundary check, and ships tests for `"hello @Will Pfleger!"` (`mentions.rs:107-152, 430-455`). And 7 of the 52 agents registered on this machine have a space in `name`, so agent handles are demonstrably not already slugs. Both sentences should be corrected — in a later ticket, not in the branch that carries this research.

---

## 0. What DorkOS has today

Everything in this section was opened at `042f89dae`.

### 0.1 There is no handle on any author

`authors` (`packages/db/src/schema/rooms.ts:30-65`) carries exactly six meaningful columns:

| Column         | Type      | Note                                                                                                                                                                |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | text PK   | Opaque ULID. **The only author identifier that reaches the wire** (`:33-34`)                                                                                        |
| `kind`         | text      | `'human' \| 'agent' \| 'system'` (`:36-37`)                                                                                                                         |
| `natural_key`  | text      | An agent's `agentPath`, a human's account key, or `'system'`. **Server-side only** — "a shared room must not carry a home-directory path to its members" (`:39-44`) |
| `display_name` | text      | "a render cache, refreshed on every resolve … never the key, and nothing may look an author up by it" (`:25-27`, `:44`)                                             |
| `emoji`        | text null | Render cache (`:49-54`)                                                                                                                                             |
| `color`        | text null | Render cache (`:56-60`)                                                                                                                                             |

Unique index on `(kind, natural_key)` (`:64`). **No handle column, and no candidate for one:** `display_name` is explicitly disqualified by its own doc comment, and `natural_key` is explicitly forbidden from reaching a client.

The table is also **mint-on-first-use** (`author-registry.ts:142-199`), so it holds one row per entity that has actually been in a room rather than one per registered agent. On this machine that is six rows — four agents, one human, one system — against 52 registered agents. Anything that migrates this table is therefore much smaller than the agent roster suggests.

Better Auth's `user` table (`packages/db/src/schema/auth.ts:22-36`) has `id`, `name`, `email` (unique), **`image`** and `role`. No handle. `image` is a nullable text column that already exists and has no UI reading it — a repo-wide grep for a settings or profile surface consuming it returns nothing. **Avatars for humans are a UI change with no schema work.**

`agents` (`packages/db/src/schema/mesh.ts:4-36`) has `name` NOT NULL and `displayName` nullable.

### 0.2 Seven agents on this machine are unaddressable by any string

```sql
SELECT COUNT(*) FROM agents;                        -- 52
SELECT COUNT(*) FROM agents WHERE name LIKE '% %';  -- 7
```

The seven:

| `name`               | `project_path`                                          | registered |
| -------------------- | ------------------------------------------------------- | ---------- |
| Art Blocks Analytics | `~/Keep/artblocks/ab-analytics`                         | 2026-02-26 |
| Bella Codebase       | `~/Keep/bella/code/bella`                               | 2026-03-19 |
| DorkOS Marketplace   | `~/.dork/workspaces/marketplace/flow-plugin-extraction` | 2026-04-11 |
| Bravo Agent          | `~/tmp/dorkos-e2e-agent-b`                              | 2026-07-18 |
| Alpha Remount Agent  | `~/tmp/dorkos-e2e-agent-remount-a`                      | 2026-07-21 |
| Bravo Remount Agent  | `~/tmp/dorkos-e2e-agent-remount-b`                      | 2026-07-21 |
| E2E Test Agent       | `~/tmp/dorkos-e2e-agent`                                | 2026-07-26 |

**Four of the seven are e2e fixtures** under `~/tmp/dorkos-e2e-*`, minted by the browser suite. Only three are agents a person made — and all three predate 2026-05. The count of seven is literally true and the practical population is three, which matters for sizing the backfill but not for whether it is needed: the fixtures prove the registration path still admits a spaced name today.

**Why the create path did not catch them.** `CreateAgentOptionsSchema.name` is `z.string().regex(AGENT_NAME_REGEX, 'Kebab-case required')` (`packages/shared/src/mesh-schemas.ts:415`), and `AGENT_NAME_REGEX` is `/^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/` (`packages/shared/src/validation.ts:17`). But `AgentManifestSchema.name` — the shape of `.dork/agent.json`, which ADR-0043 makes the source of truth — is `z.string().min(1)` (`mesh-schemas.ts:157`). All three real spaced agents have their space in the on-disk manifest:

```json
{ "name": "Art Blocks Analytics", "displayName": null, "id": "01KJCY27A18JHJA0CGQYKKBW9S" }
```

So the constraint exists on one path and not on the path that reconciles from disk. **A backfill cannot derive a handle from `agents.name` alone and then walk away; the manifest will re-supply the spaced name on the next reconcile** unless the handle lives somewhere the reconciler does not overwrite. `authors.handle` is exactly such a place: `AuthorRegistry.resolve` refreshes `displayName`, `emoji` and `color` on every resolve (`author-registry.ts:149-171`) and would leave a handle column alone unless told otherwise.

A slugifier already exists and is already tested: `slugifyAgentName` (`validation.ts:43-57`) lowercases, replaces every non-`[a-z0-9]` run with `-`, strips leading/trailing hyphens, prefixes `a-` when the result starts with a digit, caps at 64, and returns `'agent'` for empty input.

### 0.3 The mention pattern truncates at the first space, and a picker cannot save the string an agent writes

```js
// apps/server/src/services/rooms/mentions.ts:36
const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_.-]*)/g;
```

Run against real names from this machine (`agents.name` on the left, since that is what `namesFor` tries first):

```
"@Art Blocks Analytics" -> [ 'Art' ]      agents.name has a space -> resolves to nobody
"@mio-clicker-pm"       -> [ 'mio-clicker-pm' ]   already a slug -> resolves
"@You"                  -> [ 'You' ]      the human, addressable as the word "You"
```

`claimNames` (`mentions.ts:69-78`) keys the roster on the whole lowercased name, so `'art blocks analytics'` is the key and `'art'` matches nothing. **`@Art Blocks Analytics` resolves to nobody.**

**Note which column that is.** The author whose `display_name` is `Mio Clicker PM` reads like the obvious example and is not one: its `agents.name` is `mio-clicker-pm`, and both `namesFor` and `handleFor` read `name` before `displayName`. Confusing the two columns is easy and consequential — it is the difference between a defect that fires today and one that fires on the next join.

The client half is already honest about this. `advertisedHandle` (`mentions.ts:104-114`) offers a member the first name that is both typeable whole (`WHOLE_HANDLE`, `:48`) and owned by that member, returning `undefined` otherwise; `buildMentionRows` renders such a member disabled with the reason `'No @name'` (`apps/client/src/layers/features/mentions/lib/mention-rows.ts:96-99`). The picker is correct. **The picker is not the only writer.**

### 0.4 The agent is handed the un-typeable name and told to use it

This is the finding that turns the gap from cosmetic into a live defect.

`buildRoomContext` computes a `handle` per roster member (`apps/server/src/services/rooms/room-context.ts:143-175`), and `handleFor` returns, for a non-agent, `record.displayName`, and for an agent, `agents.byPath(naturalKey)?.name ?? displayName` (`:286-297`). That value is rendered into the agent's context block:

```ts
// apps/server/src/services/runtimes/shared/room-context-block.ts:181-187
const handle = `@${label(member.handle)}`;
if (member.isSelf) return `${handle} (you)`;
if (member.isPerson) return `${handle} (person)`;
...
```

and, at `:228`, `You are @${label(self.handle)}.`

`label` is `sanitizeIdentity` with a fallback (`:109-111`). `sanitizeIdentity` (`packages/shared/src/untrusted-text.ts:65-77`) strips invisible formatting characters and control characters, removes `<` and `>`, **collapses whitespace runs to a single space**, trims and caps at 80. It does not slugify and does not remove spaces.

So an agent in a room with `Art Blocks Analytics` is shown the line `@Art Blocks Analytics (agent)`, told that a handle is _"what an `@mention` resolves against"_ (`packages/shared/src/additional-context.ts:130`), writes `@Art Blocks Analytics`, and reaches nobody — `MENTION_PATTERN` captures `Art`. The `room-context.ts` doc comment states the invariant this violates in so many words:

> _"A handle the agent cannot be addressed by would be worse than no handle: it invites a message that reaches nobody."_ (`room-context.ts:290-292`)

**The invariant is right, the code does not hold it, and today nothing has fallen through — which is a finding in its own right.** Simulating `handleFor` over every row `authors` actually holds on this machine yields a typeable handle for all six (`You`, `dopel`, `mio-clicker-pm`, `mio-click-code`, `LifeOS`, `DorkOS`). The near-miss is instructive: the author whose `display_name` is `Mio Clicker PM` is **not** a counter-example, because `handleFor` reads `agents.byPath(naturalKey)?.name` first (`room-context.ts:294-297`) and that agent's `name` is the legal slug `mio-clicker-pm`. Of the seven agents whose `agents.name` does contain a space, **none has ever joined a room**.

So this is **latent**, and the honest reading is that the guard is missing rather than that the product is broken. It is one join away for three agents that already exist, on a path with no check, and the schema cannot currently stop it — `AgentManifestSchema.name` is `z.string().min(1)` (`packages/shared/src/mesh-schemas.ts:157`) and the manifest is the source of truth (ADR-0043). The affected population being zero is exactly what makes now the cheap moment to restrict.

**And the human's handle is the string `'You'.'** `LOCAL_HUMAN_DISPLAY_NAME = 'You'` (`author-registry.ts:56`), so `handleFor`returns`'You'`for the person, which is typeable, is claimed, and does resolve. An agent addressing the operator writes`@You`.

### 0.5 What is already right, and must not be redone

- **Mentions resolve once, at write time, and the entry stores author ids.** `RoomService.post` writes `mentions: resolveMentions(input.text, this.roster.mentionCandidates(roomId))` (`room-service.ts:587`) into `roomEntries.mentions` (`packages/db/src/schema/rooms.ts:207`). A rename cannot re-address an old message and an edit cannot pull somebody into a conversation retroactively (`mentions.ts:4-8`). **Renaming is already safe. Reuse is the open vector.**
- **The local→account path is already built.** `bindOwner(userId)` rewrites `natural_key` from `'local'` to `user:<id>` **in place**, leaving the opaque `id` untouched, so every `room_entries.author_id`, `room_members` row, `room_sessions` binding and read cursor keeps pointing at the same author (`author-registry.ts:261-317`). `isOwner` reads one predicate with two modes (`:319-344`). `resolveCaller` reaches `bindOwner` from both the signed-in branch and the login-off branch (`routes/room-caller.ts:62-70`), which is why turning login off is not a data loss.
- **`room_members` is keyed `(roomId, authorId)`** (`packages/db/src/schema/rooms.ts:148`), so a per-room nickname column is a pure addition whenever anyone wants one.
- **The client already receives resolved mention ids on every entry** — `RoomEntrySchema.mentions` (`packages/shared/src/room-schemas.ts:297-299`), described as _"Never re-parsed by the client."_

### 0.6 What is missing on the render side

There is **no mention rendering at all.** `RoomEntryRow` renders `entry.body.text` through `MarkdownContent` → `Streamdown` (`apps/client/src/layers/widgets/room-view/ui/RoomEntryRow.tsx:80-82`; `apps/client/src/layers/shared/ui/markdown-content.tsx:61`). A repo-wide grep for mention styling in `apps/client` returns nothing: no chip component, no CSS class, no rehype plugin. `@Mio` in a room today renders as the literal characters `@Mio` in prose.

This corrects a premise worth stating plainly, because it changes what the first phase of work is: **unresolved text is not currently styled as a mention, because nothing is.** The defect is not "we style a dead mention"; it is "we hand an agent an address that does not work, and we have no render path that could ever show the difference." When mention rendering is built, the rule that only resolved mentions render as chips has to be built in from the first commit rather than retrofitted.

There is also a **constraint on how a chip can be built**: `mentions` is a list of ids with no positions, and the schema forbids the client from re-parsing the text to find them. Rendering a chip whose label follows a rename therefore needs write-time **spans** (offset + length + authorId) alongside the ids. `roomEntries.body` is a JSON blob (`packages/db/src/schema/rooms.ts:204`), so that is a body-shape addition with no migration, degrading to plain text on entries written before it.

### 0.7 There are no broadcast keywords

A grep across `apps/server/src`, `apps/client/src` and `packages/` for `@here`, `@channel` and `@everyone` returns nothing. Whatever is decided about them is being decided on a blank slate, with no blocklist anywhere to keep in sync.

---

## 1. Slack — the handle was removed, and the reason does not transfer

**Slack once had `@username` and retired it deliberately.**

> _"Slack is phasing out the `@username` artifact in favor of the more expressive and flexible concept of display names."_ … _"The `name` field isn't disappearing yet. It's just becoming less significant and we'll eventually phase it out in a year or so… Pretend as if the `name` field doesn't exist."_
> — [The one about usernames, Slack changelog](https://docs.slack.dev/changelog/2017-09-the-one-about-usernames/)

**Name-based addressing stopped functioning on 2018-09-12.** The user's claimed date is exact:

> _"The undocumented approach to mentioning users via the API — `<@username>` — will no longer function after September 12, 2018."_ — same changelog

**Mentions are id tokens.**

> _"To mention a user, provide their user ID with the following syntax: `Hey <@U012AB3CD>, thanks for submitting your report.`"_
> — [Formatting text for app surfaces](https://docs.slack.dev/messaging/formatting-message-text)

**The id-plus-cached-label form is deprecated too**, which is the interesting half: Slack rejected even carrying a stale display string beside the id.

> _"The user mentioning syntax `<@W123|bronte>` is now deprecated and will eventually be removed."_ … _"Use the user ID-only form `<@W123>` instead."_ — changelog

**Display names are explicitly not unique.**

> _"`display_name` is not unique and may contain a relatively full gamut of UTF-8 characters."_ — changelog

**Collisions are handled by progressive disclosure.** This is officially stated, but by Slack's account on X rather than in documentation, so treat the provenance as weaker than the rest:

> _"When you type a few letters after the @ sign you will be able to see their full names also. The same applies for when you hover over the mention in a channel, etc."_
> — [@SlackHQ](https://x.com/SlackHQ/status/938337479626842112), replying to a question about display-name collisions

**Broadcast keywords are a separate token type, not reserved names.**

> _"Hey `<!here>`, there's a new task in your queue."_ … _"`<!subteam^ID>`"_, where _"`!subteam^` is a literal string that should not change, but ID should be replaced with the actual user group ID."_
> — [Formatting text for app surfaces](https://docs.slack.dev/messaging/formatting-message-text)

`<@…>` and `<!…>` are different sigils in the same grammar. A user can be called `here` and it cannot collide with `<!here>`, because a user is never written with `!`. **There is no blocklist to maintain, in any route, tool or client.** This is the cleanest transferable idea in the whole survey and it costs nothing.

### Why Slack's conclusion does not transfer

Slack can delete the handle because **every mention that reaches Slack's API was written by something that knew the id.** A human uses the composer's picker; an app constructs `<@U012AB3CD>` from an id it already holds. There is no author in Slack that composes prose and expects a name in it to address someone.

DorkOS has three such authors and is about to have a fourth:

1. **An agent's turn text.** `collectReply` accumulates the turn's `text_delta`s and posts the lot (`room-turn-runner.ts`, described at `specs/room-participation/02-specification.md` §10.2). The model writes a string.
2. **`post_to_room`**, the RP6 tool: capability `rooms.post`, tier `act`, routing through `RoomService.post` so it "inherits the mention resolution" (same section). Its argument is text.
3. **The external `/mcp` server**, which the same section notes is how a Codex or OpenCode user reaches the rooms capability at all, since `supportsMcp` is `false` for both (`runtimes/codex/runtime-constants.ts:39`, `runtimes/opencode/runtime-constants.ts:40`).
4. **Relay adapters**, which already carry inbound text from Slack and Telegram into DorkOS.

None of these can open a picker. For each of them the string **is** the interface. So the question Slack answered — "does a handle earn its place next to a picker?" — is not our question. Ours is: "what string does a model write to address a person, and is it guaranteed to work?" Slack has no evidence on it because Slack never faced it.

---

## 2. Discord — the migration that proves case-insensitivity

Discord ran the largest handle migration on record and published its reasoning, which makes it the best available evidence for two of our decisions.

**The failure they were fixing.**

> _"More than 40% of you either don't remember your discriminator or don't even know what a discriminator is."_
> _"Almost half of all friend requests fail to connect the user with the person they wanted to match with."_
> _"Mostly because users enter an incorrect or invalid username due to a combination of missing discriminator **and incorrect casing**."_
> — [Evolving Usernames on Discord](https://discord.com/blog/usernames/), May 2023 (emphasis added)

**Casing is named, by the platform, as a co-cause of a ~50% failure rate on its primary addressing action.** That is the single strongest piece of evidence in this document, and it points one way: **case-insensitive matching, or better, a lowercase-only charset that makes the question moot.**

**The charset they chose.**

> _"They'll be limited to lowercase characters (a-z), numbers (0-9) and two special characters (period and underscore)."_ — Discord blog
> _"Usernames must be between 2 and 32 characters long."_ — [User Resource, Discord developer docs](https://docs.discord.com/developers/resources/user)
> _"Usernames cannot use 2 consecutive period characters ( . )"_ — [New Usernames & Display Names, Discord support](https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names)

Lowercase ASCII plus `.` and `_`, 2–32, no `..`. **Restriction, not detection**: a charset of `[a-z0-9_.]` cannot express a Cyrillic homoglyph, so there is no confusable class to detect. (Discord does not frame it this way; the property is a consequence of the charset, not a stated goal.)

**Three layers, not two.**

> _"A non-unique Display Name that can include just about anything … including special characters, spaces, emojis and non-Latin characters."_
> _"If you already use a Server Nickname in a particular community, that Server Nickname will still take priority over your Display Name in that server."_ — Discord blog

Unique username → non-unique global display name → per-guild nickname.

**Reserved names are enforced, and this is where the separate-token-type argument bites.**

> _"Usernames cannot contain the following substrings: `@`, `#`, `:`, ` ``` `, `discord`"_ and _"Usernames cannot be: `everyone`, `here`."_
> — [User Resource, Discord developer docs](https://docs.discord.com/developers/resources/user)

`everyone` and `here` are reserved **because Discord's broadcast keywords share the `@` sigil with user mentions.** Slack pays nothing for the same feature because `<!here>` is a different token. Discord pays a blocklist that has to be enforced everywhere a name can be set, forever, and it is not free: the same page also says _"There are other rules and restrictions not shared here for the sake of spam and abuse mitigation"_ — an undocumented tail that clients cannot predict.

The user's brief also listed `system message` as reserved. **That is not in Discord's official developer documentation** — it appears only in an unofficial third-party mirror. Given the "other rules not shared here" caveat it may well be real, but it is not confirmed, and this document does not assert it.

**Forced assignment.**

> _"Starting March 4, 2024, Discord will begin assigning new usernames to users who have not chosen one themselves."_
> — [New Usernames & Display Names, Discord support](https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names)

Date confirmed.

**UNVERIFIED — the four-digit / six-digit derivation.** The brief claimed Discord derived a username for non-choosers by appending four digits, extended to six in the final week. **No primary source supports this.** The claim traces to a fan wiki. The only digit-suffix rule confirmed in Discord's own support article is unrelated and current: an unverified account gets five random digits appended seven days after creation, as anti-spam. **Do not repeat the four-to-six claim as fact.** The underlying design lesson — that late derivation into an exhausted namespace degrades — is still sound on the arithmetic alone (Discord's user base is ~10^8–10^9; a DorkOS install's agent roster is ~50 on this machine), but it is now an argument from scale, not from a cited Discord behaviour.

**PARTIALLY VERIFIED — squatting and extortion.** Concern about username squatting during the migration is documented in press coverage:

> _"It would theoretically be straightforward to use an army of dormant accounts to 'squat' usernames of famous people or business entities."_
> — [Malwarebytes, May 2023](https://www.malwarebytes.com/blog/news/2023/05/new-discord-username-policy-raises-user-privacy-fears)

**No reporting was found tying organised extortion attempts specifically to Discord Partners or verified-server owners.** The brief's stronger claim is not supported. (A separate 2023 Discord extortion incident involved a breached third-party support vendor and has nothing to do with usernames; do not conflate them.)

---

## 3. Matrix — disambiguation instead of uniqueness, and the hole in it

**Two fields, not three.** A Matrix user is an MXID (`@localpart:server`) plus a per-room `displayname` on their `m.room.member` state event. There is no third handle. The spec's own word for the MXID's human-facing role is "handle", and it says that role is secondary:

> _"Firstly, we chose to exclude characters outside the basic US-ASCII character set. User IDs are primarily intended for use as an identifier at the protocol level, and their use as a human-readable handle is of secondary benefit."_
> — [Matrix spec, Appendices — User Identifiers](https://spec.matrix.org/latest/appendices/#user-identifiers)

**Uniqueness of the visible name is not enforced. It is disambiguated at render time**, by every client, on every paint:

> _"Clients may wish to show the human-readable display name of a room member as part of a membership list, or when they send a message. However, different members may have conflicting display names. Display names MUST be disambiguated before showing them to the user, **in order to prevent spoofing of other users**."_
>
> _"To ensure this is done consistently across clients, clients SHOULD use the following algorithm … 3. If the `m.room.member` event has a `displayname` which is unique among members of the room with `membership: join` or `membership: invite`, use the given `displayname` … Otherwise: 4. The `m.room.member` event has a non-unique `displayname`. This should be disambiguated using the user id, for example 'display name (@id:homeserver.org)'."_
> — [Matrix spec, Calculating the display name for a user](https://spec.matrix.org/latest/client-server-api/#calculating-the-display-name-for-a-user)

The spoofing rationale is verbatim in the spec, and the "unique among members of the room" test is what makes the cost structural: **the predicate is over the room's whole membership**, so a single display-name change invalidates the computed name of every colliding member and forces a recomputation across the roster. There is no stored answer to invalidate — the disambiguated name is derived, per client, per render.

**And the grammar for the thing being compared was never specified.** [matrix-org/matrix-spec issue #177](https://github.com/matrix-org/matrix-spec/issues/177), _"Grammar and disambiguation of display names (SPEC-392)"_, is **open**, labelled `feature`, and raises exactly the unresolved questions a comparison needs answered: whether empty or whitespace-only names are permitted, what happens to leading and trailing whitespace, and whether Unicode normalization applies. An algorithm that is `SHOULD` for every client, over a field with no defined grammar, is an algorithm every client implements slightly differently.

**The homoglyph hole.** Because the test is string equality, a name that merely _looks_ identical never collides, and disambiguation never fires. This is documented — at the reference-client level, not the spec level:

> _"When two users have the same display name Riot disambiguates them by showing the full mxid. However, a user can have a display name that **looks** identical to someone else, by substituting e.g. latin letters with similar cyrillic ones."_
> — [element-hq/element-web issue #5826](https://github.com/vector-im/element-web/issues/5826), _"Display names are vulnerable to homoglyph attacks"_, opened 2017-12-12, labelled `Security`, `S-Major`, `P1`

Its worked example is `Mаrk` with a Cyrillic `а` against `Mark` with a Latin `a`. The disambiguation rule is a **detection** mechanism, and this is the input class detection misses. **No spec-level MSC addressing confusables was found**, and the issue's final disposition could not be confirmed — so the vulnerability is documented, the fix is not.

**MXIDs are lowercase-only, and Matrix's stated reason is the same one Discord learned the hard way.** This is the most useful thing in the Matrix section and the brief did not mention it:

> _"The `localpart` of a user ID … MUST NOT be empty, and MUST contain only the characters `a-z`, `0-9`, `.`, `_`, `=`, `-`, `/`, and `+`."\_
>
> _"We chose to disallow upper-case characters because we do not consider it valid to have two user IDs which differ only in case… Forbidding upper-case characters (and requiring homeservers to downcase usernames when creating user IDs for new users) is a relatively simple way to ensure that `@USER:matrix.org` cannot refer to a different user to `@user:matrix.org`."_
> — [Matrix spec, Appendices — User Identifiers](https://spec.matrix.org/latest/appendices/#user-identifiers)

**Two independent products, from opposite directions, landed on lowercase-only.** Matrix reasoned to it from spoofing; Discord measured its way to it from a ~50% friend-request failure rate. That is as close to consensus as this survey gets.

Matrix also carries a **grandfather clause**, which is the cost of not having restricted from day one:

> _"Older versions of this specification were more tolerant of the characters permitted in user ID localparts. There are currently active users whose user IDs do not conform to the permitted character set… clients and servers MUST accept user IDs with localparts consisting of any legal non-surrogate Unicode code points except for `:` and `NUL`… Use of the historical character set is deprecated."_
> — same appendix

Every Matrix client must implement two grammars forever, one of them deprecated. **Restricting the charset before there is a population is free; restricting it after is a permanent compatibility surface.** DorkOS has three real spaced agent names and a `'You'` (§0.2, §0.4) — the population that would need grandfathering is small enough to migrate rather than accommodate, and that window is open now.

**There is no MXID rename.** No endpoint in the Client-Server API changes a localpart; the value is set at registration and never after. Community documentation states the consequence plainly: a different username means a new account. **This is verified by absence of a mechanism rather than by an explicit prohibition** — no spec sentence says "MUST NOT rename". The design trade is stark: Matrix can never suffer handle reuse because a handle is never freed, and a user who picks badly can never fix it.

---

## 4. GitHub — reuse is the vector, and the attack is named after it

**A username freed by a rename is immediately claimable.**

> _"After changing your username, your old username becomes available for anyone else to claim."_
> — [Username changes, GitHub Docs](https://docs.github.com/en/account-and-profile/concepts/username-changes)

**A username freed by account deletion is not** — it is held for 90 days. This corrects the brief, which said "immediately claimable" without qualification:

> _"Your username will be available for anyone to use after 90 days."_
> — [Personal account reference, GitHub Docs](https://docs.github.com/en/account-and-profile/reference/personal-account-reference)

So GitHub has a delay on one path and none on the other. **A 90-day hold is a rate limit on opportunistic reclamation, not a defence against a targeted one** — an attacker who wants a specific freed name simply waits.

**The mitigation retires the pair, not the name.** GitHub's own 2018 announcement is unambiguous, and it names the threshold:

> _"To prevent developers from pulling down potentially unsafe packages, we now retire the namespace of any open source project **that had more than 100 clones in the week leading up to the owner's account being renamed or deleted**. Developers **will still be able to sign up using the login of renamed or deleted accounts**, but they will not be able to create repositories with the names of retired namespaces."_
> — [New tools for open source maintainers, GitHub Blog, 2018-04-18](https://github.blog/2018-04-18-new-tools-for-open-source-maintainers/)

The handle itself is reclaimable by anyone. Only the popular `OWNER/REPO` combination is retired. (A parallel rule exists for container images above 5,000 downloads, retiring `NAMESPACE/IMAGE-NAME`.)

**And that mitigation was bypassed four times.** Checkmarx is the primary research source and coined the name:

- **2022-05-27** — [GitHub RepoJacking Weakness Exploited in the Wild](https://checkmarx.com/blog/github-repojacking-weakness-exploited-in-the-wild-by-attackers/): reverse the sequence. Create a throwaway account, build a repo under the _target repo name_, then rename the account to the _target username_ — the retirement check is on the wrong side of the ordering. Checkmarx notes it was being exploited in the wild.
- **2022-10-26** — [Attacking the Software Supply Chain with a Simple Rename](https://checkmarx.com/blog/attacking-the-software-supply-chain-with-a-simple-rename/): a race through the repository-transfer feature. Disclosed 2021-11-08, GitHub claimed a fix 2022-03-24, Checkmarx found it still live, permanent fix 2022-09-19. Rated High, bounty paid.
- **2023-09-12** — [Persistent Threat](https://checkmarx.com/blog/persistent-threat-new-exploit-puts-thousands-of-github-repositories-and-millions-of-users-at-risk/): a race between repository creation and the username-change API fired near-simultaneously. Disclosed 2023-03-01, fixed 2023-09-01.

**Two years, four bypasses, of a mitigation that only ever covered the popular fraction of the namespace.** The generalizable finding is not "GitHub is careless" — it is that **once a name can be reclaimed at all, the defence becomes a race the platform has to keep winning.** A permanent reservation has no race to lose.

**GitHub explicitly refuses to reserve names**, which is a real counter-argument and deserves to be stated rather than buried:

> _"GitHub prohibits account name squatting, and account names may not be reserved or inactively held for future use."_
> _"Attempts to sell, buy, or solicit other forms of payment in exchange for account names are prohibited and may result in permanent account suspension."_
> _"[Trademark complaints are] the only requests we review for possible release of a username that is already claimed."_
> — [GitHub Username Policy](https://docs.github.com/en/site-policy/other-site-policies/github-username-policy)

That policy is about **users** hoarding names in a global namespace of ~10^8 accounts, where a reserved name is a name denied to a real person. It is not evidence against a **system-enforced** tombstone in a namespace of ~50 entities on one machine, where nobody is competing for `@bella-codebase`. The two situations share a word and not a problem. But the distinction has to be made explicitly, because "GitHub bans reserving usernames" is a true sentence someone will reach for.

---

## 5. Buzz — a unique handle the mention path never reads

Block's Buzz is the closest analogue in this survey: a chat relay whose participants are humans **and** agents, with the agents driven by a harness that writes prose. It is the one system here that has already made the mistake we are trying to avoid, and it made it in a specific, instructive way.

### 5.1 The handle is real, enforced, case-folded and community-scoped

```sql
-- migrations/0001_initial_schema.sql:154-179
CREATE TABLE users (
    community_id        UUID NOT NULL REFERENCES communities(id),
    pubkey              BYTEA NOT NULL,
    nip05_handle        VARCHAR(255),
    display_name        VARCHAR(255),
    ...
);

-- NIP-05 handle and Okta id unique within a community, not globally.
CREATE UNIQUE INDEX idx_users_nip05 ON users (community_id, lower(nip05_handle))
    WHERE nip05_handle IS NOT NULL;
```

Four properties in one index: **case-folded** (`lower(...)`), **scoped** (`community_id` leads), **optional** (partial, `WHERE ... IS NOT NULL`, so many NULLs coexist), and **enforced in the database** rather than in a service.

**The empty-string trap is handled, and they wrote down why:**

> _"Empty strings are treated as 'clear to NULL' — this is important for kind:0 absolute-state semantics where absent fields must be cleared, and for the `nip05_handle` column which has a UNIQUE constraint (multiple NULLs are allowed, but multiple empty strings would violate uniqueness)."_
> — `crates/buzz-db/src/user.rs:95-101`; implemented as `fn empty_to_none(val: Option<&str>) -> Option<&str> { val.filter(|s| !s.is_empty()) }` at `:139-141`

A partial unique index over a nullable column and an empty string that is not coerced to NULL is a bug that fires on the **second** user who clears their handle, not the first. Buzz hit it and fixed it in the write path.

**Lookup is case-insensitive at the query too**, not only at the index: `WHERE community_id = $1 AND LOWER(nip05_handle) = LOWER($2)` (`user.rs:189`).

**The domain half is not user-choosable.** `canonicalize_nip05` (`crates/buzz-relay/src/api/nip05.rs:79-99`) requires `local@domain`, lowercases both halves, and refuses any domain that is not the bound tenant's host:

```rust
if canonical_domain != expected_domain {
    return Err(format!("nip05_handle domain must match this relay ({})", expected_domain));
}
```

So a Buzz handle is one user-chosen token plus a server-fixed suffix — closer to a bare handle than to an email address.

### 5.2 Contention is resolved by silently dropping the handle

This is the part the brief did not have, and it is the most directly applicable lesson.

A profile arrives as a kind:0 event. The handler canonicalizes the `nip05` field, keeps it only if valid (`crates/buzz-relay/src/handlers/side_effects.rs:1225-1229`), and writes the profile. If the unique index rejects it, the handler retries **without the handle**:

```rust
// crates/buzz-relay/src/handlers/side_effects.rs:1263-1276
if msg.contains("duplicate key value") || msg.contains("23505") {
    warn!(pubkey = %hex::encode(&pubkey_bytes),
        "kind:0 NIP-05 handle contested, syncing profile without it");
    state.db.update_user_profile(..., None /* skip contested NIP-05 */).await?;
```

Their own documentation states it as intended behaviour:

> _"NIP-05 handles must canonicalize to this relay's domain — off-domain or invalid handles are silently cleared. If a NIP-05 handle collides with another user's (UNIQUE constraint), the handle is skipped but other profile fields (display_name, avatar, about) are still synced."_ — `NOSTR.md:52`

**A user who picks a taken handle is told nothing.** The only trace is a server log line. The uniqueness is real; the feedback is absent. For DorkOS this argues that handle assignment must be a **typed refusal at the write boundary** — a named error a route, a tool and a form can all render — rather than a best-effort write that degrades. That posture already has a precedent in this repo: `RoomError` codes like `ROOM_ARCHIVED` and `MEMBER_NOT_FOUND` (`room-service.ts:563-568`).

### 5.3 The mention path never consults the handle

Buzz has two `@`-mention resolvers. **Neither reads `nip05_handle`.**

**The SDK's pure resolver** matches extracted names against kind:0 profile JSON, reading `display_name` and falling back to `name` only when `display_name` is absent (`crates/buzz-sdk/src/mentions.rs:188-192`). The NIP-05 field of the profile is never looked at. The function's own doc comment states the consequence:

> _"Duplicate display names within a channel will produce multiple matches for a single `@name` — **this is by design**; resolution is bounded to channel members, so ambiguity is local to that channel."_
> — `crates/buzz-sdk/src/mentions.rs:176-178`

And there is a test that asserts it:

```rust
// crates/buzz-sdk/src/mentions.rs:584-596
#[test]
fn match_returns_all_pubkeys_for_duplicate_display_names() {
    // Ambiguity is intentional and bounded to channel members.
    let names = vec!["alice".to_string()];
    let profiles = vec![
        profile("pk1", r#"{"display_name":"Alice"}"#),
        profile("pk2", r#"{"display_name":"alice"}"#),
    ];
    assert_eq!(match_names_to_profiles(&names, &profiles), vec!["pk1", "pk2"]);
}
```

**`@alice` notifies every Alice, and that is a pinned, deliberate behaviour.**

**The CLI's resolver** does the same thing end to end. `resolve_content_mentions` (`crates/buzz-cli/src/commands/messages.rs:128-198`) queries channel members (kind 39002), then their profiles (kind 0), and builds its name index from `display_name` (falling back to `name`) only — `nip05` is never read. Its index type is `HashMap<String, Vec<String>>`, one name to **many** pubkeys, and it flat-maps the lot into the outgoing p-tags (`:190-198`).

**Where `nip05_handle` _is_ read**, for accuracy: the ACP harness includes it in the `known_names` set fed to **slash-command** detection (`crates/buzz-acp/src/pool.rs:1832-1838`), and `resolve_prompt_label` falls back to it when rendering a sender's **label** in a prompt (`crates/buzz-acp/src/queue.rs:1042-1057`). So the column is not dead — it is read by the labelling and command paths and skipped by the two paths that decide who gets notified. That is a sharper finding than "never consults it": **the handle is good enough to print and not wired to address.**

### 5.4 Buzz resolves multi-word mentions, which falsifies our own comment

`extract_at_mentions_with_known` (`crates/buzz-sdk/src/mentions.rs:107-152`) takes the roster's known names, sorts them **longest-first** (`sorted.sort_by_key(|k| std::cmp::Reverse(k.len()))`, `:117`), and at each `@` preceded by whitespace tries each known name as a case-insensitive prefix of the remainder, accepting it only if a **word boundary** follows (`:132-135`, `is_word_boundary` at `:154-158`, accepting whitespace, end-of-string, or `,;.!?:)]}`). It falls back to single-word tokenization when nothing matches.

Its tests:

```rust
#[test] fn known_multiword_name_matches_fully() {                     // :430
    let result = extract_at_mentions_with_known("hello @Will Pfleger!", &["Will Pfleger"]);
    assert_eq!(result, vec!["will pfleger"]);
}
#[test] fn longest_first_wins_over_prefix() {                          // :447
    let result = extract_at_mentions_with_known(
        "@Will Pfleger sent a message", &["Will", "Will Pfleger"]);
    assert_eq!(result, vec!["will pfleger"]);
}
#[test] fn partial_first_word_does_not_match_multiword_name() {        // :437
    let result = extract_at_mentions_with_known("hey @Will how are you", &["Will Pfleger"]);
    assert_eq!(result, vec!["will"]);   // falls back to single-word, matches nobody downstream
}
```

Our `mentions.ts:28-35` says:

> _"Spanning a space would make `@Ana and Bo` ambiguous between one member and two, and **no chat product resolves that well without an autocomplete that writes a delimiter. Agent handles are already slugs.**"_

**Both sentences are false.** Buzz is a chat product, it resolves multi-word mentions against a roster with no delimiter and no autocomplete, and it ships tests for the exact shape. And 7 of 52 agents here have a space in `name` (§0.2), so agent handles are not already slugs.

Two qualifications, so the correction does not overshoot. First, longest-first is a **policy** on the ambiguity, not a dissolution of it: given a roster containing both `Ana` and `Ana and Bo`, `@Ana and Bo` resolves to the longer name, which is a defensible tiebreak and not a proof that the text was unambiguous. Second, Buzz's approach costs a roster-sized scan per `@` and makes the resolvable set depend on who is in the room — properties a slug handle does not have. **The comment's conclusion (require a typeable handle) survives; its two supporting sentences do not.** They should be corrected in a follow-up ticket, not in this branch.

### 5.5 Rendering — UNVERIFIED

The brief claims Buzz "renders raw text and shows stale names forever." Buzz stores message content verbatim (`strip_code_regions` is documented as used "only for mention scanning — the original content is stored verbatim", `mentions.rs:239-243`), and mentions ride as p-tags carrying pubkeys, so a client **could** re-render from the tag. Buzz's own chat clients are Nostr clients outside this repository, and the in-repo `admin-web` was not audited for a message renderer. **The storage half is verified; the rendering claim is not, and this document does not assert it.**

---

## 6. Every claim in the brief, adjudicated

| #   | Claim                                                                                                                              | Verdict                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `authors` has no handle; opaque ULID `id`; unique `(kind, naturalKey)`                                                             | **Verified** — `packages/db/src/schema/rooms.ts:30-65`                                                                                                                                                                                                                                            |
| 2   | Better Auth `user` has `image`, no handle                                                                                          | **Verified** — `packages/db/src/schema/auth.ts:22-36`; no UI reads `image`                                                                                                                                                                                                                        |
| 3   | 7 of 52 agents have a space in `name`                                                                                              | **Verified**, with a caveat: **4 of the 7 are e2e fixtures**; 3 are real, all registered before 2026-05                                                                                                                                                                                           |
| 4   | `MENTION_PATTERN` truncates at a space                                                                                             | **Verified** — `mentions.ts:36`; `@Art Blocks Analytics` → `['Art']` → resolves to nobody. (Not `Mio Clicker PM`: that is a `display_name`, and its `agents.name` is the legal slug `mio-clicker-pm`.)                                                                                            |
| 5   | Mentions resolve once at write time and store ids                                                                                  | **Verified** — `room-service.ts:587`, `packages/db/src/schema/rooms.ts:207`                                                                                                                                                                                                                       |
| 6   | `bindOwner` migrates the sentinel in place; `id` never changes                                                                     | **Verified** — `author-registry.ts:297-317`                                                                                                                                                                                                                                                       |
| 7   | The local human is named `'You'` and has no handle                                                                                 | **Verified** — `author-registry.ts:56`; and it is what the agent is told to type                                                                                                                                                                                                                  |
| 8   | Slack `<@username>` stopped functioning 2018-09-12                                                                                 | **Verified** — Slack changelog, exact date                                                                                                                                                                                                                                                        |
| 9   | Slack mentions are `<@U012AB3CD>`; `<@W123\|bronte>` deprecated                                                                    | **Verified** — Slack changelog + formatting docs                                                                                                                                                                                                                                                  |
| 10  | Slack display names explicitly not unique                                                                                          | **Verified** — Slack changelog                                                                                                                                                                                                                                                                    |
| 11  | Slack handles collisions by hover disclosure                                                                                       | **Partially verified** — stated by @SlackHQ on X, not in documentation                                                                                                                                                                                                                            |
| 12  | Slack broadcast keywords are a separate token type                                                                                 | **Verified** — `<!here>`, `<!channel>`, `<!subteam^ID>` in the formatting docs                                                                                                                                                                                                                    |
| 13  | Discord: >40% didn't know their discriminator; ~half of friend requests failed; casing named                                       | **Verified** — Discord blog, all three, verbatim                                                                                                                                                                                                                                                  |
| 14  | Discord charset `[a-z0-9_.]`, 2–32, no `..`                                                                                        | **Verified** — Discord blog + developer docs + support article                                                                                                                                                                                                                                    |
| 15  | Discord three layers                                                                                                               | **Verified** — Discord blog                                                                                                                                                                                                                                                                       |
| 16  | Discord reserves `everyone`, `here`, `system message`, contains-`discord`                                                          | **Partially verified** — `everyone`, `here`, contains-`discord` confirmed in developer docs; **`system message` is not in any official Discord source**                                                                                                                                           |
| 17  | Forced assignment 2024-03-04                                                                                                       | **Verified** — Discord support article                                                                                                                                                                                                                                                            |
| 18  | Derivation appended four digits, extended to six in the final week                                                                 | **UNVERIFIED** — no primary source; traces to a fan wiki. Do not repeat                                                                                                                                                                                                                           |
| 19  | Documented extortion attempts against Discord Partners                                                                             | **UNVERIFIED** — squatting concern is documented in press; **extortion against Partners is not**                                                                                                                                                                                                  |
| 20  | Matrix: MXID + per-room display name, no third field                                                                               | **Verified** — spec appendix; the spec calls the MXID itself the "human-readable handle" and says that role is secondary                                                                                                                                                                          |
| 21  | Matrix render-time disambiguation, spec says "to prevent spoofing"                                                                 | **Verified** — the phrase is verbatim in the Client-Server API                                                                                                                                                                                                                                    |
| 22  | Rename is O(room); display-name grammar undefined; matrix-spec #177 still open                                                     | **Verified**, with a correction: **MXIDs cannot be renamed at all**, so the O(room) cost is on a **display-name** change. #177 is open and is about display-name grammar. The **MXID** grammar _is_ defined                                                                                       |
| 23  | Matrix homoglyph hole: `@аna` never collides, so disambiguation never fires                                                        | **Verified** at client level — element-web #5826, labelled `Security`. **No spec-level MSC exists**, and the issue's disposition could not be confirmed                                                                                                                                           |
| 23b | _(not in the brief)_ Matrix mandates lowercase-only MXIDs for the same reason Discord learned                                      | **Verified** — _"we do not consider it valid to have two user IDs which differ only in case"_. Two products, opposite reasoning, same conclusion                                                                                                                                                  |
| 24  | Buzz enforces a unique, case-folded, community-scoped, optional handle                                                             | **Verified** — `migrations/0001_initial_schema.sql:178-179`                                                                                                                                                                                                                                       |
| 25  | The domain half is not user-choosable                                                                                              | **Verified** — `crates/buzz-relay/src/api/nip05.rs:79-99`                                                                                                                                                                                                                                         |
| 26  | The mention path never consults it                                                                                                 | **Verified, and sharper**: neither mention resolver reads it (`mentions.rs:188-192`, `messages.rs:159-198`), but the **slash-command** and **prompt-label** paths do (`pool.rs:1832-1838`, `queue.rs:1042-1057`)                                                                                  |
| 27  | Doc comment says duplicates are "by design"; a test asserts `@alice` notifies every Alice                                          | **Verified** — `mentions.rs:176-178, 584-596`                                                                                                                                                                                                                                                     |
| 28  | Buzz hit the empty-string-vs-NULL trap                                                                                             | **Verified** — `user.rs:95-101, 139-141`                                                                                                                                                                                                                                                          |
| 29  | `extract_at_mentions_with_known` does longest-first roster matching with a word-boundary check, tested on `"hello @Will Pfleger!"` | **Verified** — `mentions.rs:107-152, 430-455`                                                                                                                                                                                                                                                     |
| 30  | Our `mentions.ts:31-34` comment is false on both counts                                                                            | **Verified false on both counts** — see §5.4 for the two qualifications                                                                                                                                                                                                                           |
| 31  | Buzz renders raw text and shows stale names forever                                                                                | **UNVERIFIED** — storage-verbatim is verified; no in-repo message renderer was audited                                                                                                                                                                                                            |
| 32  | GitHub frees a username for immediate reuse                                                                                        | **Partially verified** — immediate after a **rename**; a **deletion** holds the name for **90 days**. The brief did not distinguish them                                                                                                                                                          |
| 33  | Namespace retirement retires the `OWNER/REPO` combination, not the handle                                                          | **Verified** — GitHub's 2018 post, verbatim, including the **>100 clones in the preceding week** threshold                                                                                                                                                                                        |
| 34  | Repojacking; Checkmarx found a bypass                                                                                              | **Verified, and understated** — Checkmarx documents **four** distinct bypasses across 2021–2023, three of them races                                                                                                                                                                              |
| 34b | _(not in the brief)_ GitHub explicitly prohibits reserving or inactively holding a username                                        | **Verified** — Username Policy. A real counter-argument to a tombstone, addressed in §4: it governs users hoarding in a 10^8 namespace, not a system reserving in a ~50-entity one                                                                                                                |
| 35  | Unresolved `@text` "still renders styled as a mention" today                                                                       | **FALSE** — there is no mention rendering in the client at all (§0.6). The real defect is upstream and **latent**: `handleFor` hands an agent `agents.name` unfiltered, which is un-typeable for 7 of 52 agents — none of which has joined a room, so all six current author rows are fine (§0.4) |

---

## 7. What follows for DorkOS

Stated as findings, not as a design. The design is `specs/handles/`.

1. **A handle is load-bearing here in a way it is not for Slack**, because DorkOS has non-human authors that compose message text with no picker in front of them (§1). This is the finding the whole spec turns on, and it is verifiable at four call sites.
2. **Case-insensitivity is the closest thing to consensus in the survey**, reached twice from opposite directions: Discord measured wrong casing as a co-cause of a ~50% friend-request failure rate (§2); Matrix reasoned to lowercase-only from spoofing, because _"we do not consider it valid to have two user IDs which differ only in case"_ (§3). A lowercase-only charset makes the question moot rather than merely handled.
3. **Restriction beats detection.** A lowercase-ASCII charset cannot express a homoglyph, so the confusable class does not exist to be caught. Matrix's disambiguation is the detection alternative, and it has a documented `Security`-labelled hole precisely there (§3).
4. **Restrict before there is a population, or carry two grammars forever.** Matrix's historical-MXID clause is what "we will tighten it later" actually costs: every client must accept a deprecated legacy character set indefinitely (§3). DorkOS's non-conforming population is three real agents and one `'You'` (§0.2, §0.4) — small enough to migrate. That window is open now and closes as rooms get used.
5. **Broadcast keywords should be a separate token type.** Slack pays nothing for this; Discord pays a blocklist plus an explicitly undocumented tail (§1, §2). DorkOS has no keywords anywhere yet (§0.7), so the choice is free today and expensive later.
6. **Deriving a handle is cheap at our scale and got expensive at Discord's** because of namespace exhaustion, not because derivation is wrong. The argument is now arithmetic — ~10^8 accounts versus 52 agents on this machine — since the four-to-six-digit anecdote turned out to be unverified (§2).
7. **Renaming is already safe; reuse is the open vector.** Write-time id resolution (§0.5) means a rename cannot re-address history. What it cannot protect against is a freed handle being claimed by somebody else — GitHub's failure mode, where the mitigation covers only the popular fraction of the namespace and was bypassed four times in two years (§4). Matrix avoids the vector entirely by never freeing a handle, at the price that a bad choice is permanent (§3). **A tombstone takes Matrix's safety without Matrix's price**, and GitHub's anti-squatting policy is not evidence against it (§4).
8. **Enforce at the write boundary with a typed refusal.** Buzz enforces uniqueness in the index and then swallows the violation with a `warn!` the user never sees (§5.2). The database constraint is necessary and not sufficient.
9. **Having the column is not the work.** Buzz has the column and neither of its mention resolvers reads it (§5.3). The acceptance criterion for this feature is that `resolveMentions`, `advertisedHandle`, `handleFor` and the picker all read the same field.
10. **A chip whose label follows a rename needs write-time spans**, because the client holds ids without positions and is forbidden from re-parsing (§0.6). `body` is JSON, so this costs no migration.
11. **Empty string is not NULL.** A partial unique index over a nullable handle fires on the second person who clears theirs, not the first — Buzz hit it and coerces in the write path (§5.1).
12. **Two of our own comments need correcting** (§5.4) — in a follow-up ticket, so this branch stays documentation-only.

---

## 8. What could not be verified

- **Discord's four-digit / six-digit derivation fallback** (§2). No primary source. Traces to a fan wiki.
- **Extortion attempts against Discord Partners** during the username migration (§2). General squatting concern is documented in press coverage; the Partner-targeted extortion claim is not.
- **`system message` as a Discord reserved username** (§2). Present only in an unofficial mirror of Discord's docs.
- **Slack's collision-handling rationale** (§1). Officially stated on X, not in documentation.
- **A spec-level Matrix response to homoglyphs** (§3). No MSC was found; the only documented treatment is a reference-client issue, and its final disposition could not be confirmed.
- **An explicit Matrix prohibition on renaming an MXID** (§3). Immutability is established by the absence of any mechanism in the Client-Server API, not by a sentence saying so.
- **Buzz's mention rendering** (§5.5). Buzz's chat clients are outside the repository; the in-repo `admin-web` was not audited.
- **Whether any Buzz behaviour is intentional versus incidental.** The clone is shallow (`--depth 1`), so there is no history and no commit message to read design intent out of. Every Buzz claim is a claim about the working tree at `55a3ed7b`.

## References

**DorkOS** (all at `042f89dae`): `packages/db/src/schema/rooms.ts`, `packages/db/src/schema/auth.ts`, `packages/db/src/schema/mesh.ts`, `packages/shared/src/mesh-schemas.ts`, `packages/shared/src/validation.ts`, `packages/shared/src/room-schemas.ts`, `packages/shared/src/additional-context.ts`, `packages/shared/src/untrusted-text.ts`, `apps/server/src/services/rooms/{mentions,author-registry,room-roster,room-service,room-context,addressing,room-turn-runner}.ts`, `apps/server/src/services/runtimes/shared/room-context-block.ts`, `apps/server/src/routes/room-caller.ts`, `apps/client/src/layers/features/mentions/lib/mention-rows.ts`, `apps/client/src/layers/widgets/room-view/ui/RoomEntryRow.tsx`, `apps/client/src/layers/shared/ui/markdown-content.tsx`, `specs/room-participation/02-specification.md`.

**Buzz** (all at `55a3ed7b9217cee5b23e0a5441947dc929b2a38c`): `migrations/0001_initial_schema.sql`, `crates/buzz-sdk/src/mentions.rs`, `crates/buzz-db/src/user.rs`, `crates/buzz-cli/src/commands/messages.rs`, `crates/buzz-relay/src/api/nip05.rs`, `crates/buzz-relay/src/handlers/side_effects.rs`, `crates/buzz-acp/src/pool.rs`, `crates/buzz-acp/src/queue.rs`, `NOSTR.md`.

**Slack:** [The one about usernames](https://docs.slack.dev/changelog/2017-09-the-one-about-usernames/) · [Formatting text for app surfaces](https://docs.slack.dev/messaging/formatting-message-text) · [@SlackHQ on display-name collisions](https://x.com/SlackHQ/status/938337479626842112)

**Discord:** [Evolving Usernames on Discord](https://discord.com/blog/usernames/) · [User Resource — Usernames and Nicknames](https://docs.discord.com/developers/resources/user) · [New Usernames & Display Names](https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names) · [Malwarebytes on squatting risk](https://www.malwarebytes.com/blog/news/2023/05/new-discord-username-policy-raises-user-privacy-fears)

**Matrix:** [Appendices — User Identifiers](https://spec.matrix.org/latest/appendices/#user-identifiers) · [Calculating the display name for a user](https://spec.matrix.org/latest/client-server-api/#calculating-the-display-name-for-a-user) · [matrix-spec issue #177 — Grammar and disambiguation of display names](https://github.com/matrix-org/matrix-spec/issues/177) · [element-web issue #5826 — Display names are vulnerable to homoglyph attacks](https://github.com/vector-im/element-web/issues/5826)

**GitHub:** [Username changes](https://docs.github.com/en/account-and-profile/concepts/username-changes) · [Personal account reference](https://docs.github.com/en/account-and-profile/reference/personal-account-reference) · [New tools for open source maintainers (2018)](https://github.blog/2018-04-18-new-tools-for-open-source-maintainers/) · [GitHub Username Policy](https://docs.github.com/en/site-policy/other-site-policies/github-username-policy) · Checkmarx: [exploited in the wild](https://checkmarx.com/blog/github-repojacking-weakness-exploited-in-the-wild-by-attackers/) · [a simple rename](https://checkmarx.com/blog/attacking-the-software-supply-chain-with-a-simple-rename/) · [persistent threat](https://checkmarx.com/blog/persistent-threat-new-exploit-puts-thousands-of-github-repositories-and-millions-of-users-at-risk/)

**Prior DorkOS research:** `research/20260727_buzz-protocol-capability-spike.md`, `research/20260727_agent-identity-in-communities.md`, `research/20260727_thread-models.md`.
