---
slug: handles
id: 260728-225135
created: 2026-07-28
status: specified
---

# Handles — one addressable name for every author in a room

**Status:** Specified (frozen for DECOMPOSE)
**Author:** Claude (directed by Dorian), SPECIFY stage
**Date:** 2026-07-28
**Research basis:** `research/20260728_handle-systems-prior-art.md` (Slack, Discord, Matrix, GitHub, Buzz @ `55a3ed7b9217cee5b23e0a5441947dc929b2a38c`). Ideation: `specs/handles/01-ideation.md`.
**Tracker:** **DOR-675** (Phase 1, the room-context guard) · **DOR-676** (Phase 2, `authors.handle`) · **DOR-677** (Phase 3, the human surface)
**Follows:** DOR-631 (`3f4b8f036`), the `@` mention picker. **Adjacent:** `specs/room-participation` §10.1–§10.2 (RP5 picker, RP6 `post_to_room`), `specs/community-adapter` (remote identity).

## Overview

Every author in a DorkOS room gets a **handle**: one short, lowercase, unique, typeable token that addresses exactly them.

```
authors
  id           01K…                         opaque, attribution, never typed
  kind         agent
  natural_key  /Users/…/ab-analytics        server-side only, never on the wire
  handle       art-blocks-analytics         NEW — the address. unique, lowercase, typeable
  display_name Art Blocks Analytics         render cache. unrestricted. never a key
```

Three columns already exist and each has one job. The fourth is missing, and its absence is why an agent can be handed the address `@Art Blocks Analytics`, told that is what a mention resolves against, and reach nobody. That agent is registered on this machine today; it has simply not joined a room yet, which is the only reason nobody has hit this.

The work is three phases. **Phase 1 makes the address we already give an agent honest, and adds no column.** **Phase 2 adds `authors.handle`** — grammar, derivation, backfill, uniqueness, tombstones — and, in the same change, **deletes the display-name addressing path it supersedes**. **Phase 3 is the human surface**: onboarding capture, profile editing, avatars, the hover card and the profile drawer.

## Background / Problem Statement

### There is no handle

`authors` (`packages/db/src/schema/rooms.ts:30-65`) has an opaque ULID `id`, a `kind`, a server-side `natural_key` explicitly forbidden from reaching a client (`:39-44`), and a `display_name` its own doc comment disqualifies from ever being looked up by:

> _"`display_name` is a render cache, refreshed on every resolve. It is never the key, and nothing may look an author up by it."_ — `packages/db/src/schema/rooms.ts:27-29`

Better Auth's `user` has `id`, `name`, `email` and `image` (`packages/db/src/schema/auth.ts:22-36`). No handle. `agents` has `name` and a nullable `displayName` (`packages/db/src/schema/mesh.ts:4-36`), and `AgentManifestSchema.name` — the shape of the on-disk file ADR-0043 makes the source of truth — is `z.string().min(1)` (`packages/shared/src/mesh-schemas.ts:157`). **Seven of the 52 agents registered on this machine have a space in `name`.** Four are e2e fixtures; three are agents a person made, all before 2026-05. The person at the keyboard is called `'You'` (`author-registry.ts:56`).

### Slack removed the handle, and we cannot follow

Slack deprecated name-based addressing: `<@username>` stopped functioning on 2018-09-12, mentions are `<@U012AB3CD>` id tokens, even the id-plus-cached-label `<@W123|bronte>` is deprecated, and display names are explicitly not unique. Collisions are handled by showing more on hover. That is a coherent design, and **it rests on a premise DorkOS does not share: in Slack, every mention was written by something that already knew the id.**

We have four writers that cannot know an id and cannot open a picker:

| Writer                     | What it emits                                                                                         | Verified                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| An agent's DM reply        | free-form model text, collected off the projector and posted whole                                    | `room-turn-runner.ts:16-21`; `specs/room-participation/02-specification.md` §10.2     |
| `post_to_room` (RP6)       | a `text` argument, routed through `RoomService.post` so it _"inherits the mention resolution"_        | `specs/room-participation/02-specification.md` §10.2                                  |
| The external `/mcp` server | the same tool, which is how Codex and OpenCode reach rooms at all — `supportsMcp` is `false` for both | `runtimes/codex/runtime-constants.ts:39`, `runtimes/opencode/runtime-constants.ts:40` |
| Relay adapters             | inbound text from Slack, Telegram and the rest                                                        | `packages/relay/src/adapters/`                                                        |

**For each of them the string is the interface.** Slack's question was "does a handle earn its place next to a picker?"; ours is "what does a model write to address a person, and is it guaranteed to work?" Slack has no evidence on ours because Slack never faced it.

### The defect this is already causing

`buildRoomContext` computes a `handle` per roster member (`room-context.ts:143-175`). `handleFor` (`:286-297`) returns `agents.byPath(naturalKey)?.name` for an agent and `record.displayName` for everyone else. That value is rendered to the model:

```ts
// apps/server/src/services/runtimes/shared/room-context-block.ts:181-187
const handle = `@${label(member.handle)}`;
if (member.isSelf) return `${handle} (you)`;
if (member.isPerson) return `${handle} (person)`;
```

and at `:228`, `You are @${label(self.handle)}.` The shared schema calls the field _"What an `@mention` resolves against"_ (`packages/shared/src/additional-context.ts:130`).

`label` is `sanitizeIdentity` (`packages/shared/src/untrusted-text.ts:65-77`), which strips control and invisible characters, removes `<`/`>`, **collapses whitespace runs to a single space**, and caps at 80. It does not slugify. So an agent in a room with `Art Blocks Analytics` receives `@Art Blocks Analytics (agent)` and writes it back, and:

```js
// MENTION_PATTERN, mentions.ts:36
/@([A-Za-z0-9][A-Za-z0-9_.-]*)/g
"@Art Blocks Analytics" -> ["Art"]
```

`claimNames` keys the roster on the whole lowercased name (`mentions.ts:69-78`), so `'art'` matches nothing. **The message reaches nobody and nothing anywhere says so.** The file computing the address already states the invariant it is breaking:

> _"A handle the agent cannot be addressed by would be worse than no handle: it invites a message that reaches nobody."_ — `room-context.ts:290-292`

**This is latent, not live, and the distinction is worth stating precisely** — it is the difference between a bug report and a design argument. Simulating `handleFor` over every row `authors` actually holds on this machine returns a typeable handle for all six:

| author row               | `handleFor` returns |          |
| ------------------------ | ------------------- | -------- |
| `You` (human)            | `You`               | typeable |
| `dopel` (agent)          | `dopel`             | typeable |
| `Mio Clicker PM` (agent) | `mio-clicker-pm`    | typeable |
| `mio-click-code` (agent) | `mio-click-code`    | typeable |
| `LifeOS` (agent)         | `LifeOS`            | typeable |
| `DorkOS` (system)        | `DorkOS`            | typeable |

`Mio Clicker PM` is the row that looks like a counter-example and is not: it is the author's **`display_name`**, while `handleFor` reads `agents.byPath(naturalKey)?.name` first (`room-context.ts:294-297`) and that agent's `name` is already the legal slug `mio-clicker-pm`. Seven agents on this machine do have a space in `agents.name` — `Art Blocks Analytics`, `Bella Codebase`, `DorkOS Marketplace` and four e2e fixtures — and **none of them has ever joined a room**, which is the entire reason this has not fired.

So the defect is one join away, on a code path with no guard, for agents that already exist. It is also a defect the schema cannot currently prevent, because `AgentManifestSchema.name` is `z.string().min(1)` (`packages/shared/src/mesh-schemas.ts:157`) and the manifest is the source of truth (ADR-0043). **The window in which the affected population is still zero is the window this spec exists to use.**

The picker half is already correct: `advertisedHandle` refuses to offer a name that is not typeable **and** owned (`mentions.ts:104-114`), and `buildMentionRows` renders such a member disabled with `'No @name'` (`mention-rows.ts:96-99`). **The picker is right. The picker is not the only writer.**

### What the field supplies

| Product | Handle                                      | Case                     | Reuse                                  | The lesson                                                                                                    |
| ------- | ------------------------------------------- | ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Slack   | Deprecated                                  | n/a                      | n/a                                    | **Broadcast keywords are a separate token type** (`<!here>`), so no blocklist                                 |
| Discord | Unique, `[a-z0-9_.]`, 2–32                  | Lowercase-only           | —                                      | Wrong **casing** named as a cause of a ~50% friend-request failure rate                                       |
| Matrix  | MXID + display name, no third field         | **Lowercase-only** MXIDs | Never freed — no rename exists         | Render-time disambiguation misses homoglyphs; the display-name grammar is still unspecified (#177)            |
| GitHub  | Unique, global                              | Case-insensitive         | Immediate on rename, 90 days on delete | **Repojacking** — four bypasses, 2021–2023                                                                    |
| Buzz    | Unique per community, case-folded, optional | Case-folded              | n/a                                    | **The mention path never reads it.** Duplicates are "by design". A contested handle is dropped with a `warn!` |

Two of those are decisive and both come from outside our own reasoning. **Discord measured its way to lowercase-only and Matrix reasoned its way there**, from a failure rate and from spoofing respectively — the closest thing to consensus in the survey. And **Buzz proves that having the column is not the work**: it has a case-folded unique handle in the database and neither of its `@`-mention resolvers reads it (`crates/buzz-sdk/src/mentions.rs:188-192`, `crates/buzz-cli/src/commands/messages.rs:159-198`), shipping a test that asserts `@alice` notifies every Alice (`mentions.rs:584-596`).

## Decisions (LOCKED — from ideation, do not relitigate)

`specs/handles/01-ideation.md` §6, D1–D12, in full. The five that bind hardest:

1. **D1** — the handle lives on `authors`, nullable, partial-unique on `lower(handle)`, empty string coerced to NULL at the write boundary.
2. **D4** — a freed handle is **tombstoned to its original author, permanently**; the original may reclaim its own.
3. **D5** — broadcast keywords are a **separate token type**, never `@word`, and **there is no blocklist**.
4. **D11** — a taken handle is a **typed refusal at the write boundary**, not a silent degrade.
5. **D12** — the handle is written **once at mint** and never refreshed by `AuthorRegistry.resolve`. The mesh reconciler rebuilds `agents` from disk every five minutes; a re-derived handle would be silently overwritten by whatever the manifest currently says, spaces included.

## Decisions resolved in SPECIFY

Each was open at the end of ideation. The rationale matters as much as the answer.

- **S1 — Does the display name stay addressable alongside the handle? RESOLVED: no. It is removed, in the same change.** This is the largest decision in the document and it was not on the ideation's list, because answering open question 4 forced it. `claimNames` and `advertisedHandle` exist **only** because display names are neither unique nor typeable (`mentions.ts:56-68, 80-103`). A unique typeable handle removes both premises. Keeping the fallback means keeping a second addressing mechanism whose entire job is to be worse than the first — and it reintroduces the exact Buzz failure, `@alice` reaching whichever Alice the roster happened to order first. `AGENTS.md`: _"when something is superseded, remove it."_ The migration cost is nil, because resolution is at write time: entries written before the change already carry resolved ids and are never re-resolved (`room-service.ts:587`). See §5.

- **S2 — Does the system author get a handle? RESOLVED: yes, `dorkos`, and it is a reservation more than an address.** The system author is the room's own voice (`author-registry.ts:49-53`). It is already excluded from the picker (`mention-rows.ts:85`) and already un-triggerable, because addressing filters to `kind === 'agent'` (`addressing.ts:84`). None of that is the reason to give it a handle. **The reason is impersonation:** without a reservation, an agent whose manifest `name` is `DorkOS` derives `@dorkos`, and thereafter every `@dorkos` in the room addresses it instead of the room. **The reservation must be seeded at boot, not minted lazily** — an earlier draft claimed it needed "no special case anywhere", and that was wrong in a way that failed open. §4a has the ordering bug and the fix, and `everyone`, `here` and `channel` ride the same mechanism for the reason §1 gives. (No conflict with DorkBot, the system _agent_ at `~/.dork/agents/dorkbot/`, which derives `@dorkbot`.)

- **S3 — Length? RESOLVED: 2–32, matching Discord.** Our namespace is ~50 entities, so nothing about our scale argues for a bound at all; what argues is that a shipped, tested-at-scale bound beats an invented one, and 32 is long enough that truncation is rare. **`handle` is deliberately not the same grammar as `agents.name`** (`AGENT_NAME_REGEX`, 1–64, `[a-z][a-z0-9-]*`, `validation.ts:17`) and the two must not be conflated: `agents.name` is a path-safe identifier for a manifest, `handle` is an address in a room.

- **S3b — Does derivation reuse `slugifyAgentName`? RESOLVED: no, and this overturns the ideation.** `01-ideation.md` D7 proposed reusing it, on the reasonable grounds that a second slugifier needs justification. **Measurement overturned it.** `slugifyAgentName` targets `AGENT_NAME_REGEX`, so it flattens every non-alphanumeric run to `-` and prefixes `a-` for a leading digit — both correct for its own grammar and wrong for this one, which permits `.`, `_` and a leading digit. Run over the `agents.name` of all 52 agents on this machine, it **changes the working address of four of them**:

  | `agents.name`       | via `slugifyAgentName` |
  | ------------------- | ---------------------- |
  | `144mono`           | `a-144mono`            |
  | `144x.co`           | `a-144x-co`            |
  | `doriancollier.com` | `doriancollier-com`    |
  | `next_starter`      | `next-starter`         |

  Each is typeable today and resolves today (`namesFor` tries `agents.name` first, `room-roster.ts:212-215`), so reuse would break four working addresses to save one function. A handle-aware normalizer (§1) over the same 52 changes **zero** addresses, produces **zero** illegal handles and **zero** collisions. _"Diverging needs justification"_ — this is the justification.

  **Four, not five.** An earlier draft listed `temp_assetops_aced_iframe` as a fifth. It is not an `agents.name` — it is that agent's `display_name`, and its `name` is `temp-assetops-aced-iframe`, which `slugifyAgentName` returns unchanged. The draft's measurement had been run over `COALESCE(display_name, name)` rather than over `name`, which is the same column confusion S3c exists to settle. Corrected here rather than quietly, because a number used as an argument has to survive being checked.

- **S3c — What does derivation read? RESOLVED: `agents.name`, with the display name only as a fallback when `name` yields nothing legal.** `namesFor` puts `agents.name` first today (`room-roster.ts:212-215`), so it is the string that currently addresses an agent, and deriving from it preserves that. Deriving from the display name instead would do real damage: `temp-assetops-aced-iframe` is the working address and `temp_assetops_aced_iframe` is merely how it renders, so display-name derivation would swap a live address for a cosmetic one. The 7 agents whose `name` has a space have no `displayName` at all, so they fall through to the same string either way and get a slug: `Art Blocks Analytics` → `art-blocks-analytics`, `Bella Codebase` → `bella-codebase`.

  **Every table in this document that names a string is keyed on `agents.name`**, reached through the author's `natural_key` (`agents.byPath`). `display_name` never feeds derivation. Getting this backwards is the single most likely way to implement the backfill wrong, because for most agent rows the two columns differ.

- **S4 — What does the de-collision suffix look like? RESOLVED: a decimal counter, `-2`, `-3`, …, and no "you probably want to change this" flag.** Not random digits: the Discord lesson is that an unmemorable assigned suffix is a suffix nobody can use. A counter is predictable, and at ~50 entities it will almost never exceed one digit. No flag, because the surface that would carry it is the same agent-settings surface that carries the edit affordance — the handle is shown and editable there always, so a suffixed one needs no separate nag. (`AGENTS.md`: every element justifies its existence.)

- **S5 — Does `AuthorRef.mentionHandle` survive? RESOLVED: no, it collapses into `AuthorRef.handle`.** `mentionHandle` exists because what a picker may offer had to be computed **per roster**, over the whole ownership map, since a display name a member quietly answers to could belong to somebody else (`room-roster.ts:123-137`). Under S1, ownership is not roster-relative any more: the handle is unique by index, so the author who has it is the author it reaches, everywhere, with no map. The field becomes `handle: string | null` on `AuthorRef`, populated from the row, and `RoomRoster.list` stops computing anything. `null` still means "cannot be addressed", which the picker already renders (`mention-rows.ts:96-99`) — during the Phase 2 backfill window, and afterwards only for an author that has not been given one.

- **S6 — Is changing a handle rate-limited? RESOLVED: no, because no automated path can change one.** Rate limiting is the wrong instrument for the risk (a tombstone row per change, forever, from an agent looping). The right instrument is to have no loop: **handle changes are human-initiated only.** There is no MCP tool, no capability, and no agent-reachable route that writes a handle. That is an invariant with a test, not a throttle with a tuning parameter — and it matches how the repo already treats this class of thing (`EnabledToolGroupsSchema` gains no key; §10.2 of the room-participation spec makes the same move for a different reason).

- **S7 — Does an unresolved `@token` produce a room notice? RESOLVED: no.** `mentions.ts:10-11` already has the right instinct: _"An unresolvable `@name` stays plain text. It is not an error, it is somebody writing an email address or a price."_ A notice would fire on prices and email addresses, and the room's notice budget is already carefully damped (`specs/room-participation/02-specification.md` §5.2). **The cause is removed instead of the symptom being reported**: Phase 1 stops handing an agent an address that cannot work, which is the only case where an unresolved token was a system error rather than prose.

## Goals

- **G1** — `authors.handle`: nullable text, partial-unique on `lower(handle)` where not null, empty string coerced to NULL at the write boundary.
- **G2** — **One grammar, in one module.** `packages/shared/src/handle.ts` defines validation, normalization and derivation. No second definition anywhere — not in a route, not in a Zod schema body, not on the client.
- **G3** — Every author row has a handle, or honestly has none. On this machine the backfill is **six rows** (`authors` is mint-on-first-use); the other 48 registered agents get theirs at mint; the human's is asked for rather than derived; and `dorkos`, `everyone`, `here` and `channel` are seeded at boot before anything can be minted.
- **G4** — A freed handle is tombstoned to its releasing author permanently, and that author may reclaim it.
- **G5** — `resolveMentions`, the mention picker, and `buildRoomContext` **all read the same field**, and a test proves they cannot disagree. This is the criterion Buzz fails.
- **G6** — The display-name addressing path is **deleted**, not deprecated: `claimNames`, `advertisedHandle` and `AuthorRef.mentionHandle` go.
- **G7** — A mention renders as a chip whose label follows the resolved author's current display name, from **write-time spans**, with the body text unchanged.
- **G8** — Phase 1 ships independently and closes the room-context defect with no schema change.

## Non-Goals

- **Not** renaming agents, and **not** the agent-creation UI. `agents.name` and `agents.displayName` keep their meanings; `AGENT_NAME_REGEX` is untouched.
- **Not** community or remote-member identity. `specs/community-adapter` owns that. §2 records the one line that keeps this extensible.
- **Not** the `mentions.ts:28-35` comment correction. The research falsifies two of its sentences; fixing them is a one-line follow-up so this stays reviewable.
- **Not** per-room nicknames (D6). `room_members` is already keyed `(roomId, authorId)` (`packages/db/src/schema/rooms.ts:148`), so a nullable column later needs no unwinding.
- **Not** broadcast keywords themselves. D5 constrains their future spelling; it does not build them.
- **Not** multi-word mention matching. Buzz's longest-first algorithm is real and works (`crates/buzz-sdk/src/mentions.rs:107-152`); it is a possible **fallback** for legacy text, recorded in §9 and built by nobody here.
- **Not** an ADR. §Related ADRs names the two that would be extracted if they prove contentious.

## Technical Dependencies

- **`packages/shared`** — new module `handle.ts`, new `exports` subpath `@dorkos/shared/handle`. It owns its own normalizer rather than reusing `slugifyAgentName`, for the measured reason in S3b; `validation.ts` is untouched.
- **`packages/db`** — `drizzle-orm@^0.45.2`, `drizzle-kit@^0.31.10`. Two schema changes and one generated migration (`pnpm --filter @dorkos/db db:generate`). **The committed SQL is the authority.** The repo already ships a partial unique index built through the Drizzle builder (`rooms_channel_slug_unique`, `packages/db/src/schema/rooms.ts:115-117`); whether the same builder expresses the `lower(handle)` **expression** index directly, or the generated SQL needs hand-checking, is an EXECUTE-time detail — §2 gives the SQL that must result either way.
- **`apps/server`** — no new dependency. `ulidx` already mints every author id (`author-registry.ts:174`).
- **`apps/client`** — no new dependency. `motion` and `streamdown` are already present; the chip is a render-time transform over text the client already holds.
- **No new external package anywhere.**

## Detailed Design

### 1. The grammar, in one module

```typescript
// packages/shared/src/handle.ts

/**
 * The one definition of what a handle looks like.
 *
 * Lowercase ASCII, 2–32, starting with a letter or digit, no consecutive dots,
 * no trailing separator. Every surface that accepts, derives or renders a handle
 * reads THIS — the server's write path, the client's optimistic validation, the
 * derivation, and the mention resolver. A second copy is how a picker starts
 * offering something the resolver refuses.
 *
 * **Restrict, don't detect.** The charset cannot express a Cyrillic `а`, a
 * fullwidth `ａ`, or a zero-width joiner, so the confusable class does not exist
 * to be caught. Matrix takes the other road — disambiguate at render time when
 * two display names collide — and it has a `Security`-labelled hole exactly
 * there, because a homoglyph never string-collides and disambiguation never
 * fires (element-web #5826). A filter must be kept current against an
 * adversary; a grammar is enforced once.
 *
 * Anyone whose name this charset cannot spell is served by `display_name`,
 * which is unrestricted. That split is Discord's and it is why the split exists.
 */
export const HANDLE_PATTERN = /^[a-z0-9](?!.*\.\.)[a-z0-9._-]{0,30}[a-z0-9]$/;

/** Bounds, spelled once so a form and a schema cannot disagree. */
export const HANDLE_MIN_LENGTH = 2;
export const HANDLE_MAX_LENGTH = 32;
```

**This pattern was executed, not asserted.** Run against the §Testing table it accepts `ab`, `ana`, `mio-clicker-pm`, `bella-codebase-2`, `art-blocks-analytics`, `a_b`, `a.b`, `1ab`, `144x.co`, `next_starter`, `doriancollier.com` and a 32-character handle, and rejects the empty string, `a`, 33 characters, `Ana`, `.ana`, `ana.`, `ana-`, `ana_`, `a..b`, `ana bo`, a Cyrillic `а`, a fullwidth `ａ` and an embedded zero-width space. Every accepted value also round-trips: `MENTION_PATTERN` captures it whole from `@handle`, and `TRAILING_PUNCTUATION` shaves nothing off. And the derivation in this module, run over all 52 agents on this machine, changes **zero** working addresses, produces **zero** illegal handles and **zero** collisions.

Three properties are load-bearing and each is a rule someone will otherwise re-derive:

**Lowercase-only, not case-insensitive.** Input is lowercased before validation, so `@Ana` and `@ana` can never both exist. This is stronger than case-insensitive matching because it removes the question rather than answering it: there is never a stored mixed-case value that something must decide is equal to another. Discord measured its way here — _"users enter an incorrect or invalid username due to a combination of missing discriminator and incorrect casing"_, against _"almost half of all friend requests fail"_ — and Matrix reasoned its way here: _"we do not consider it valid to have two user IDs which differ only in case."_

**Must start _and end_ alphanumeric.** The resolver looks a token up raw and, failing that, again with `TRAILING_PUNCTUATION` (`/[.\-_]+$/`) shaved off, so `@ana.` at the end of a sentence still reaches `ana` (`mentions.ts:51-54, 134`). Raw is tried **first**, so a handle ending in `.` would in fact be reachable — **the hazard runs the other way.** If both `ana` and `ana.` existed, `@ana.` would resolve to `ana.` on the raw pass, and `ana` would lose its sentence-ending form to a neighbour. Forbidding a trailing separator costs one character of grammar and removes the whole class. `_` is excluded from the terminal position for the same reason, and because a symmetric rule — starts alphanumeric, ends alphanumeric — is one a person can hold in their head.

**No blocklist — but three reserved rows, and the reasoning that got there is worth keeping.** D5 puts broadcast keywords in a different token type, so at the grammar level `@everyone` can never _be_ a broadcast and `everyone` is an ordinary handle. Discord instead reserves `everyone` and `here` (_"Usernames cannot be: `everyone`, `here`"_) because its broadcasts share the `@` sigil, and it pays an undocumented tail for it: _"There are other rules and restrictions not shared here for the sake of spam and abuse mitigation."_ A blocklist is not one rule; it is one rule per enforcement point — the Zod schema, the derive path, the human form, the client's optimistic check — and they drift.

**That reasoning is sound and it stops one step short.** Apply this document's own §Background test — _what does a model write, and is it guaranteed to work?_ — to broadcasts, and the answer is uncomfortable: a model writes `@everyone`, because that is the spelling in its training data, and three of our four writer paths have no composer to rewrite it. Slack can split `@here` into `<!here>` precisely because its composer rewrites what a person types; we have no such converter on the paths that matter most here. So under a bare separate-token-type rule, `@everyone` written by an agent either reaches nobody (harmless) or reaches **whoever holds the handle `everyone`** — a mis-address, and one an adversarial agent could farm deliberately by claiming the name.

So: **the token type stays, and `everyone`, `here` and `channel` are seeded reservations** (§4a), held by the system author in the same tombstone table under the same unique index. This is still not a blocklist — there is no list consulted at any enforcement point, and nothing new to keep in sync across routes, tools and the client. It is three rows. The distinction is the whole point: Discord pays a rule at every boundary; we pay three rows at boot, once.

```typescript
/**
 * Normalize a candidate handle: trim, lowercase, and treat empty as absent.
 *
 * `undefined` for an empty result is not a convenience — it is what keeps the
 * partial unique index correct. Multiple NULLs coexist under it; multiple
 * empty strings do not. Buzz hit this and coerces in its write path for the
 * same reason: *"multiple NULLs are allowed, but multiple empty strings would
 * violate uniqueness"* (`crates/buzz-db/src/user.rs:95-101`).
 */
export function normalizeHandle(raw: string): string | undefined;

/** Whether a normalized handle is legal. Returns the reason when it is not. */
export function validateHandle(handle: string): { valid: boolean; error?: string };

/**
 * Derive a handle from a name, de-colliding against `taken`.
 *
 * **Deliberately not `slugifyAgentName`** (S3b). That function targets
 * `AGENT_NAME_REGEX`, so it flattens `.` and `_` to `-` and prefixes `a-` for a
 * leading digit — right for its grammar, wrong for this one, and measurably so:
 * over the `agents.name` of the 52 agents on this machine it changes four
 * working addresses (`144mono`, `144x.co`, `doriancollier.com`,
 * `next_starter`). This normalizer changes none.
 *
 * It replaces only runs the handle grammar actually forbids, collapses
 * consecutive dots, trims to an alphanumeric first and last character, cuts
 * to 32, and trims again — because a cut can land on a separator.
 *
 * Collision appends a decimal counter: `-2`, `-3`. Not random digits. Discord's
 * migration is the cautionary tale and its lesson is that an assigned,
 * unmemorable suffix is a suffix nobody can use — but the degradation itself
 * came from deriving late into an exhausted namespace of hundreds of millions.
 * Ours is 52 agents on this machine, and over those 52 this produces no
 * collision at all.
 */
export function deriveHandle(name: string, taken: ReadonlySet<string>): string;
```

Derivation is not a slugifier looking for a home — it is `HANDLE_PATTERN` read backwards, which is why it belongs in the module that owns the pattern.

### 2. `authors.handle` and its index

```typescript
// packages/db/src/schema/rooms.ts — added to the `authors` table
    /**
     * The author's address: what somebody types after an `@` to reach them.
     *
     * Unlike `display_name`, this IS a key, and it is the only one that reaches
     * a client. Lowercase by grammar, unique by index, and — unlike everything
     * else on this row except `natural_key` — **written once at mint and never
     * refreshed on resolve** (D12). `agents` is a derived cache whose reconciler
     * rebuilds it from disk every five minutes, so a handle re-derived on each
     * resolve would be silently overwritten by whatever the manifest currently
     * says, spaces included.
     *
     * Nullable, because the migration needs a legal intermediate state and
     * because "this author cannot be addressed" is an honest thing for a row to
     * say. Never the empty string: the partial unique index below permits many
     * NULLs and exactly one `''`.
     */
    handle: text('handle'),
```

```sql
-- The authority. Whatever the Drizzle builder emits must equal this.
CREATE UNIQUE INDEX authors_handle_unique
  ON authors (lower(handle))
  WHERE handle IS NOT NULL;
```

**Why `lower(handle)` when the grammar already forbids uppercase.** It is redundant _given_ the grammar and it costs nothing, and the redundancy is the point: the constraint stops depending on every future write path remembering to normalize. Buzz folds in the index **and** lowercases on write, and its lookup folds again (`WHERE community_id = $1 AND LOWER(nip05_handle) = LOWER($2)`, `crates/buzz-db/src/user.rs:189`). The alternative — a plain `UNIQUE(handle)` plus a `CHECK` — is equally sound and strictly more machinery.

**Partial, for the same reason `rooms_channel_slug_unique` is partial** (`packages/db/src/schema/rooms.ts:112-117`): the predicate is the query. Every handle lookup asks for a non-null one, and during the backfill window most rows have none.

**Scoping is a leading column, later.** `specs/community-adapter` addresses every room as `(community, roomId)`; when a remote author lands, this index gains a leading community column and nothing else in this spec changes — not the grammar, not the resolver, not the picker. Buzz already demonstrates the shape (`CREATE UNIQUE INDEX idx_users_nip05 ON users (community_id, lower(nip05_handle)) WHERE nip05_handle IS NOT NULL`).

### 3. Tombstones

```typescript
/**
 * A handle its author released, reserved to that author forever.
 *
 * **Renaming is already safe; reuse is the vector.** Mentions resolve once at
 * write time and store author ids (`room-service.ts:587`), so a rename can
 * never re-address an old message. What that does not protect is the person who
 * remembers a name: `@bella-codebase` is released, somebody else claims it, and
 * every message a person addresses to the name they remember reaches a
 * different entity.
 *
 * Three positions exist in the field. GitHub releases (immediately on a rename;
 * after 90 days on a deletion) and retires only the popular `OWNER/REPO`
 * combination, not the login — *"Developers will still be able to sign up using
 * the login of renamed or deleted accounts"* — which is how repojacking got its
 * name and why Checkmarx documented four bypasses across 2021–2023, three of
 * them races. Matrix never frees a handle, because no MXID rename exists at
 * all; safe, and a bad choice is permanent.
 *
 * A permanent reservation takes Matrix's safety without Matrix's price, and it
 * is affordable only because of scale: in a namespace of ~50 entities nobody is
 * competing for `@bella-codebase`. (GitHub's policy prohibiting reserved
 * usernames governs *users* hoarding names in a namespace of ~10^8 accounts,
 * where a reservation denies a real name to a real person. Different problem,
 * same word.)
 *
 * The original author may always reclaim its own — the case that would
 * otherwise be infuriating, and the one the row's `author_id` exists to answer.
 */
export const handleTombstones = sqliteTable(
  'handle_tombstones',
  {
    /** The released handle. Lowercase by grammar — and by index, not by comment. */
    handle: text('handle').notNull(),
    /** Who released it. They, and only they, may take it back. */
    authorId: text('author_id').notNull(),
    releasedAt: text('released_at').notNull(),
  },
  (table) => [uniqueIndex('handle_tombstones_handle_unique').on(sql`lower(${table.handle})`)]
);
```

```sql
-- The authority, and deliberately the same shape as `authors_handle_unique`.
CREATE UNIQUE INDEX handle_tombstones_handle_unique ON handle_tombstones (lower(handle));
```

**Not a bare `text().primaryKey()`, and the reason is the argument §2 already made.** A `TEXT PRIMARY KEY` in SQLite is `BINARY`-collated, so `Ana` and `ana` would be two distinct tombstones and "already lowercased" would be enforced by a doc comment rather than by the database. §2 rejects exactly that reasoning one paragraph earlier — _"the constraint stops depending on every future write path remembering to normalize"_ — and it would be incoherent to fold the live index and not this one, when the two are checked together on every claim.

Claiming `h` is refused when `lower(h)` matches a live handle on another author **or** `lower(h)` matches a tombstone owned by another author — one predicate shape against both tables, so neither can drift into case-sensitivity on its own. Reclaiming your own tombstone deletes the row and writes the handle back. There is no expiry and no sweeper: at one row per handle change on a single-user install, growth is not a problem worth mechanism, and S6 removes the only path that could make it one.

### 4. Derivation, and the backfill

**Agents derive.** `AuthorRegistry.resolveAgent` mints a row with `handle: deriveHandle(agentName, taken)` — `agents.name` first, the display name only when `name` yields nothing legal (S3c) — **only when inserting** (`author-registry.ts:173-199`). The existing-row branch (`:149-171`) refreshes `displayName`, `emoji` and `color` and **must not touch `handle`** — D12.

**Two traps sit on that exact line, and both are silent.**

1. **The insert's conflict clause must be qualified.** It is `this.db.insert(authors).values(row).onConflictDoNothing().run()` today (`author-registry.ts:185`) — **unqualified**, so it means "on conflict with _any_ unique index". Adding `authors_handle_unique` widens it: a handle collision would silently drop the insert, and the re-read that follows queries by `(kind, naturalKey)` (`:186-190`), finds nothing, and returns `settled?.id ?? row.id` — **a ULID for a row that does not exist**. Every later `room_entries.author_id` would then point at a phantom author. The fix is one argument: `onConflictDoNothing({ target: [authors.kind, authors.naturalKey] })`, so the clause keeps meaning what it meant before this column existed, and a handle collision surfaces as a typed refusal (§8) instead of a ghost.
2. **`taken` must include tombstones.** If it is live handles only, a newly-minted agent derives straight onto a handle some other author released — defeating D4 on the path that produces _most_ handles, since 48 of 52 agents get theirs at mint. `taken` is the union of live `lower(handle)` and tombstoned `lower(handle)`, which is the same predicate §3 uses for a claim; a mint is a claim that happens not to have a person behind it.

That first trap is the single line where this design most easily regresses into something worse than nothing, and §Testing pins both.

**Humans are asked — and the asking ships in Phase 2, not Phase 3.** An earlier draft defaulted the human to `you` and deferred the capture to Phase 3's onboarding work. That would have shipped, as the default, the exact string `01-ideation.md` §5.6 names as the defect: _"The human's handle today is the string `'You'`."_ And it would have shipped it as a **permanent** default on the configuration D6 makes the norm — a login-off single-user install has no account, so an account-onboarding capture never runs, and Phase 3 may never be scheduled at all. **A phase must not ship the defect it exists to remove.**

So Phase 2 leaves the human's handle **NULL** and asks. NULL is the honest state, it is already rendered (`mention-rows.ts:96-99`), and `handleFor` already returns it honestly after Phase 1 — an agent is told the person has no handle rather than being handed a wrong one. The window is one interaction wide, because the prompt fires the first time the operator opens a room.

The capture is a step in the existing first-run flow (`OnboardingStateSchema`, `packages/shared/src/config-schema.ts:115-128`), which is a `~/.dork/config.json` block and **not** gated on auth — so it reaches the login-off install that needs it most. One field, prefilled with `deriveHandle(emailLocalpart, taken)` when an account exists and left empty when none does, **shown before it sticks**. That last part is Discord's whole finding: _"more than 40% of you either don't remember your discriminator or don't even know what a discriminator is"_ — a handle you were assigned and never saw is a handle you cannot use when you need it.

There is deliberately **no derived fallback for the human**. `you` is the defect; the OS username is personal data this repo is careful with elsewhere; and `Someone` (`author-registry.ts:64`) is a placeholder for a state that should not arise. Where there is no honest string to derive, the right answer is to ask, not to invent.

When an owner account later appears, `bindOwner` leaves the handle alone for the same reason it leaves `displayName` alone: the opaque `id` does not change, so nothing attached to it needs to (`author-registry.ts:297-317`).

**Backfill — and it is far smaller than it looks.** `authors` is **mint-on-first-use**: a row exists only for an entity that has actually been in a room (`author-registry.ts:142-199`). On this machine that is **six rows**, not fifty-four:

```sql
SELECT kind, COUNT(*) FROM authors GROUP BY kind;   -- agent 4, human 1, system 1
```

**The table below is keyed on `agents.name`, reached through the author's `natural_key`** — not on `authors.display_name`, which is what a reader glancing at the rows would assume, and which S3c forbids. For three of the four agent rows the two columns differ, so a backfill written off the wrong column produces wrong handles for most of the table.

| author row (`display_name`)     | `agents.name` via `natural_key` | handle                              | why                                                   |
| ------------------------------- | ------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| `dopel`                         | `dopel`                         | `dopel`                             | identity                                              |
| `Mio Clicker PM`                | `mio-clicker-pm`                | `mio-clicker-pm`                    | identity — **from `name`, not from the display name** |
| `mio-click-code`                | `mio-click-code`                | `mio-click-code`                    | identity                                              |
| `LifeOS`                        | `LifeOS`                        | `lifeos`                            | lowercased                                            |
| `You` (human, no agent row)     | —                               | none yet; the person is asked (§4a) | there is no honest string to derive                   |
| `DorkOS` (system, no agent row) | —                               | `dorkos`                            | seeded reservation (S2)                               |

**Under S3c not one of the six needs real derivation.** Four are identity, one is a lowercase, and the two non-agent rows are handled by rules of their own. The slugification cases — `Art Blocks Analytics` and the rest — are all in the 48 agents that have no author row, so they arrive through mint, not through migration.

**The other 48 registered agents get a handle at mint, not by migration** — the first time each one joins a room. That is the right split: a migration should touch what exists, and derivation at mint is the path every future agent takes anyway, so the backfill exercises no code the steady state does not.

It also means the namespace fills lazily, and that is fine: two agents in different directories both named `api-server` are not a conflict until the second one enters a room, at which point it derives `api-server-2` through the same de-collision every other mint uses. Nothing has to reserve a handle for an agent that has never spoken.

#### 4a. The seeded reservations, and why they cannot be lazy

**S2 originally said `dorkos` is minted "with the row", with "no special case anywhere". That was wrong, and the ordering is why.** `AuthorRegistry.system()` routes through the same mint-on-first-use `resolve()` as everything else, and it has exactly **one** production caller — `room-service.ts:639`, the `kind: 'notice'` write path. On a fresh install the system author's row therefore does not exist until the first notice fires. An agent whose manifest `name` is `DorkOS` — legal, because `AgentManifestSchema.name` is `z.string().min(1)` — that joins a room before any notice has been written would mint first, take `dorkos`, and leave the room's own voice to de-collide to `dorkos-2`. **The reservation fails open on ordering.**

So it is a special case, and saying so plainly is what makes it fixable:

> **Four handles are seeded at boot, before any author can be minted:** `dorkos` on the system author, and `everyone`, `here` and `channel` on it as well.

Seeding runs beside `ensureDorkBot` (`apps/server/src/index.ts:830`), which is already the boot-time hook for "this install must have this entity". It mints the system author eagerly rather than waiting for a notice, and writes the three broadcast words as tombstones owned by it — the same table, the same unique index, the same refusal. **There is no blocklist**: nothing checks a list of forbidden words at any enforcement point, because the reservation is data and the index is the enforcement. It is one row, not one rule per route.

Why the three broadcast words are in there at all is argued in §1; the mechanism is this one.

The migration must be **idempotent** (skip a row that already has a handle), must **not** write an empty string, and must walk rows in `created_at` order so any suffix it assigns is reproducible across a re-run.

### 5. Resolution, after the collapse

This is where the deletion happens (S1).

**Today:** `namesFor` returns `[agentName, displayName]` for an agent and `[displayName]` for everyone else (`room-roster.ts:212-215`); `claimNames` builds a first-claimant-wins map over all of those (`mentions.ts:69-78`); `advertisedHandle` picks the first name a member can be typed by **and** owns (`:104-114`); `RoomRoster.list` runs both to compute `mentionHandle` per member (`:123-137`).

**After:** `namesFor` returns `[handle]` when the author has one and `[]` when it does not. `claimNames` and `advertisedHandle` are **deleted**. `resolveMentions` becomes a lookup against a map built from one field, and the roster stops computing anything.

The whole apparatus exists to answer "which member does this ambiguous name reach?" A unique index answers it. Keeping the display-name fallback would keep a second addressing mechanism whose only distinguishing property is being worse — non-unique, sometimes untypeable, and resolving by roster order. That is precisely Buzz's shipped behaviour, complete with its test:

```rust
// crates/buzz-sdk/src/mentions.rs:584-596 — what we are declining to build
#[test]
fn match_returns_all_pubkeys_for_duplicate_display_names() {
    // Ambiguity is intentional and bounded to channel members.
    ...
    assert_eq!(match_names_to_profiles(&names, &profiles), vec!["pk1", "pk2"]);
}
```

**Nothing is lost from history.** Resolution happens once at write time and the ids are stored (`room-service.ts:587`, `packages/db/src/schema/rooms.ts:207`); an entry written before the change is never re-resolved. The only behavioural change is prospective, and it is small: after the change, a display name stops being an address. For the four agent rows that exist here that costs nothing — `dopel`, `mio-clicker-pm` and `mio-click-code` already answer to their `agents.name`, and `LifeOS` answers to `lifeos` because the resolver lowercases the token it captured (`mentions.ts:133`). **What changes is that an agent whose `name` has a space becomes addressable at all.**

`MENTION_PATTERN` itself is unchanged. It already accepts a superset of the handle grammar, which is correct: the pattern's job is to find candidate tokens in prose, and the map's job is to decide which of them address someone.

### 6. The room-context path — Phase 1, no schema

`handleFor` (`room-context.ts:286-297`) currently returns whatever it finds. It must return only a name that **round-trips**: a value that `MENTION_PATTERN` would match whole and that the map would resolve back to this author.

```typescript
/**
 * What an `@mention` resolves this author against — or nothing, honestly.
 *
 * The **same** answer `RoomRoster` gives the picker, from the same source. Two
 * derivations of "what reaches this author" is how the model gets told one
 * thing and the resolver does another, which is exactly the state this
 * function was in before Phase 1: it handed back `agents.name` unfiltered, so
 * an agent in a room with `Art Blocks Analytics` would be shown
 * `@Art Blocks Analytics`, write it, and reach nobody — while the picker,
 * reading `advertisedHandle`, correctly refused to offer that member at all.
 */
function handleFor(deps: RoomContextDeps, record: AuthorRecord): string | null;
```

`RoomContextMember.handle` becomes nullable and `room-context-block.ts` renders the honest thing for a member that has none — a name with no `@`, so the model is not invited to type one. Under Phase 2 the null case is vanishing (every author has a handle), but the type must express it, because the backfill window and a future un-handled author both produce it.

**Phase 1 is worth shipping alone**, before any column exists, because it converts a silent wrong answer into a visible absent one. `sanitizeIdentity` stays exactly as it is (`untrusted-text.ts:65-77`): it is a prompt-injection defence for labels and it is not, and must not become, a handle validator.

### 7. The chip, and why it needs spans

**The label a reader sees renders from the resolved author id, not from the body text**, so a rename propagates and the body stays exactly what was written. Buzz renders raw text and shows a stale name forever.

There is an obstacle the obvious design walks into. `RoomEntry.mentions` is a list of author ids with **no positions**, and its own schema forbids the fix: _"Author ids resolved from @name at write time. **Never re-parsed by the client.**"_ (`packages/shared/src/room-schemas.ts:297-299`). So the client cannot find the `@token` to replace.

Three ways out, and only one is consistent with what is already decided:

|     | Approach                                                   | Verdict                                                                                                                                             |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Client re-parses the body                                  | **No.** Violates the stated contract and reintroduces the client/server drift the contract exists to prevent                                        |
| 2   | Server rewrites the body to `<@id>` tokens (Slack's model) | **No.** The stored body stops being what anyone typed, which costs auditability in a product whose premise is that you can see what your agents did |
| 3   | Server emits **spans** at write time                       | **Yes**                                                                                                                                             |

```typescript
// packages/shared/src/room-schemas.ts — added to RoomEntryBodySchema
  /**
   * Where each resolved mention sits in `text`, computed by the same write-time
   * pass that produced `RoomEntry.mentions`.
   *
   * The client renders a chip over each span and looks the label up by
   * `authorId` in the roster it already holds, so a rename propagates to every
   * message without a single byte of `text` changing and without the client
   * ever parsing it — the invariant `RoomEntry.mentions` states and this field
   * makes keepable.
   *
   * Absent on every entry written before this shipped, which renders as plain
   * text. That degradation is correct: those entries pre-date the handle, so
   * their `@tokens` were display names that may no longer resolve to anything.
   */
  mentionSpans: z
    .array(z.object({ start: z.number().int().min(0), length: z.number().int().min(1), authorId: z.string().min(1) }))
    .optional(),
```

`roomEntries.body` is a JSON blob (`packages/db/src/schema/rooms.ts:204`), so this is a body-shape addition with **no migration**. Offsets are UTF-16 code-unit indices, matching `String.prototype.slice` on both sides.

**`length` is computed after the trailing-punctuation shave, not from `match[0]`.** `.`, `-` and `_` are inside `MENTION_PATTERN`'s character class, so `@ana.` at the end of a sentence matches with `match[0] === '@ana.'` (length 5) while the handle that actually resolved is `ana` (`mentions.ts:134` shaves before the second lookup). A span taken from `match[0].length` would cover the sentence's full stop and every renderer would paint it inside the chip. The span is `{ start: match.index, length: 1 + resolvedHandle.length }`. Worth spelling out because the obvious test case hides it: `@bo,` captures cleanly, since `,` is _not_ in the class.

### 8. Typed refusals

```typescript
// apps/server/src/services/rooms/room-errors.ts
export type RoomErrorCode =
  | …                     // existing
  | 'HANDLE_TAKEN'        // live on another author
  | 'HANDLE_RESERVED'     // tombstoned to another author
  | 'INVALID_HANDLE';     // fails the grammar
```

`SLUG_TAKEN` and `INVALID_SLUG` are the precedent, one line above (`room-errors.ts:18-19`), and the routes already map `RoomErrorCode` onto status codes. **Three codes, not one**, because they are three different things a person does about it: pick another, ask the person who had it, or fix the spelling. Collapsing them would make the message do work the code should.

This is the direct lesson from Buzz. It enforces uniqueness in the index and then swallows the violation:

```rust
// crates/buzz-relay/src/handlers/side_effects.rs:1263-1276
if msg.contains("duplicate key value") || msg.contains("23505") {
    warn!(pubkey = …, "kind:0 NIP-05 handle contested, syncing profile without it");
    state.db.update_user_profile(…, None /* skip contested NIP-05 */).await?;
```

Their documentation states it as intent: _"If a NIP-05 handle collides with another user's (UNIQUE constraint), the handle is skipped but other profile fields … are still synced"_ (`NOSTR.md:52`). **A user who picks a taken handle is told nothing.** The constraint is necessary and not sufficient; the refusal is the feature.

### 9. Deliberately not built

- **Multi-word matching.** Buzz's `extract_at_mentions_with_known` sorts the roster longest-first and accepts a known name as a prefix when a word boundary follows (`crates/buzz-sdk/src/mentions.rs:107-152`), tested on `"hello @Will Pfleger!"` (`:430-434`) and on `["Will", "Will Pfleger"]` disambiguating to the longer (`:447-455`). It works. It is not the foundation, because it makes the resolvable set a function of who is in the room and turns ambiguity into a tiebreak policy rather than an impossibility. Recorded here so that if legacy `@Display Name` text ever needs a fallback, the shape is known rather than rediscovered.
- **Handle history beyond the tombstone.** The tombstone records that a handle was released and by whom. A full audit trail of every handle an author ever had is a different feature with no current consumer.

### Code structure & file organization

```
packages/shared/src/
  handle.ts                      NEW — grammar, normalizer, deriver (G2)
  __tests__/handle.test.ts       NEW
  room-schemas.ts                AuthorRef.handle replaces mentionHandle; body gains mentionSpans
  validation.ts                  untouched — handle.ts owns its own normalizer (S3b)

packages/db/src/schema/
  rooms.ts                       authors.handle + authors_handle_unique + handleTombstones
packages/db/drizzle/
  00XX_*.sql                     generated; the SQL in §2 is the authority

apps/server/src/services/rooms/
  author-registry.ts             mints, reserves, refuses; NEVER refreshes handle (D12)
  room-roster.ts                 namesFor returns [handle]; list stops computing
  mentions.ts                    claimNames + advertisedHandle DELETED (S1)
  room-context.ts                handleFor returns string | null (Phase 1)
  room-service.ts                post() emits mentionSpans beside mentions
  room-errors.ts                 three new codes

apps/server/src/services/runtimes/shared/
  room-context-block.ts          renders a member with no handle honestly

apps/client/src/layers/
  features/mentions/             picker reads AuthorRef.handle
  entities/author/               NEW slice — the hover card's data hook
  features/author-profile/       NEW slice — hover card + profile drawer (Phase 3)
  widgets/room-view/ui/          RoomEntryRow renders chips from mentionSpans
  features/settings/             handle + avatar editing (Phase 3)
```

The two new client slices sit at `entities` and `features` respectively, which the FSD rule `shared ← entities ← features ← widgets` requires: the drawer is a feature that composes an entity's data, and `room-view` (a widget) may import both.

### API changes

- `AuthorRef.mentionHandle` → `AuthorRef.handle: string | null`. **A rename with a semantic change**, and the OpenAPI description changes with it: `mentionHandle` was "what a picker may offer, computed per roster"; `handle` is "this author's address, globally unique on this install". Every `RoomWithRoster` response carries it, exactly where `mentionHandle` was carried (create, read, update, and the stream's hydration snapshot).
- `RoomEntryBody.mentionSpans?: { start, length, authorId }[]` — additive and optional.
- `PATCH /api/rooms/authors/:id/handle` — **human-initiated only** (S6), refusing `HANDLE_TAKEN`, `HANDLE_RESERVED` or `INVALID_HANDLE`. It is not exposed as a capability, gets no MCP tool, and no agent-reachable route writes a handle.
- **No change** to `POST /api/rooms/:id/entries`, `GET /api/sessions/*`, mesh, or agent routes.

### Data model changes

| Change                          | Migration                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `authors.handle TEXT NULL`      | `ALTER TABLE authors ADD COLUMN handle text;`                                |
| `authors_handle_unique`         | `CREATE UNIQUE INDEX … ON authors (lower(handle)) WHERE handle IS NOT NULL;` |
| `handle_tombstones`             | new table (§3)                                                               |
| Backfill                        | one-time data migration, idempotent, `created_at`-ordered (§4)               |
| `roomEntries.body.mentionSpans` | **none** — `body` is JSON                                                    |

Nothing is dropped. `display_name` keeps its job and its unrestricted charset; what it loses is a job it never should have had.

## User Experience

**Adding an agent to a channel.** Nothing new to do. The agent already has a handle, derived when its author row was minted, shown in its settings alongside its name.

**Addressing someone.** Type `@`, and the picker opens with People then Agents (unchanged, DOR-631). Every member is now selectable — the `'No @name'` disabled state stops appearing, because every author has a handle. Typing the handle by hand works identically, which is the point: the picker becomes a convenience rather than the only route.

**An agent addressing someone.** The roster in `<room_context>` reads `@mio-clicker-pm (agent)`, `@dorian (person)`, and the agent writes `@mio-clicker-pm`. It resolves. Today it reads `@Mio Clicker PM (agent)` and does not.

**Reading a message.** A resolved mention renders as a chip carrying the author's **current** display name and their emoji/colour. Unresolved `@text` renders as plain text — no chip, no styling — which is what `mentions.ts:10-11` has always said should happen and what stops a price or an email from looking like an address.

**Hover a chip** → a card: display name, `@handle`, kind, and quick actions (open a DM, open the profile). **Click** → a profile drawer from the right. This is Slack's progressive disclosure, which is the right model even though we are not adopting the rest of Slack's design: Slack solves _collision_ by revealing more on hover, and we have no collisions — but revealing more on hover is also just how a person confirms they addressed the right entity before sending.

**Choosing your own handle.** One field in the first-run flow, prefilled from the email localpart when there is an account and empty when there is not, editable, and shown before it is saved. If the handle is taken, the form says which of the three things went wrong (§8) rather than silently keeping the old one. Until it is answered the person simply has no handle, which the picker and the agent's roster both render honestly — better than shipping `@you` and hoping a later phase replaces it.

**Renaming.** Change it in settings. Every message you have already sent keeps working, because the mention stored an id. The handle you left is yours to take back and nobody else's to claim.

**Avatars.** `user.image` already exists (`packages/db/src/schema/auth.ts:25`) and nothing reads it; `authors.emoji` and `authors.color` already exist as the render cache and are already refreshed on resolve. A human uploading an avatar is a settings surface and an upload path — **no schema work**, which is worth saying because it sounds like schema work.

## Testing Strategy

**Unit — `packages/shared/src/__tests__/handle.test.ts`**

- The grammar over a table with rows that must pass — `ab`, `mio-clicker-pm`, `144x.co`, `next_starter`, `doriancollier.com`, `a.b`, `a_b`, `1ab`, 32 characters — and rows that must fail: the empty string, `a`, 33 characters, `Ana`, `.ana`, `ana.`, `ana-`, `ana_`, `a..b`, `ana bo`, a Cyrillic `а`, a fullwidth `ａ`, an embedded zero-width space.
- **Every legal handle round-trips `MENTION_PATTERN` whole.** Property-style over the table: `MENTION_PATTERN` must match `@${handle}` and capture the whole handle, with nothing shaved by `TRAILING_PUNCTUATION`. This is the assertion that makes the grammar and the resolver one system rather than two, and it is the shape the repo already uses to pin `MENTION_PATTERN` against `WHOLE_HANDLE` (`mentions.ts:38-47`).
- `deriveHandle` over the seven spaced names, plus collision: `('Bella Codebase', {})` → `bella-codebase`; with `bella-codebase` taken → `bella-codebase-2`; a 40-character name truncates to 32 and does not end in a separator. **And the address-preservation property (S3b/S3c):** over a fixture covering each name shape found on this machine — already-legal, mixed-case, dotted, underscored, leading-digit, spaced — every name that is typeable today derives to itself, lowercased. (The fixture is written by hand, not lifted from anyone's agent list; two of the real names are personal domains.)
- `normalizeHandle('')` and `normalizeHandle('   ')` both return `undefined`.

**Unit — server**

- **The insert's conflict target is qualified** (§4 trap 1). Force a handle collision on a _new_ `(kind, naturalKey)` and assert the call refuses with `HANDLE_TAKEN` rather than returning an id for a row that was never written. Then assert `getById` on the returned id is non-null — the phantom-author assertion, which is the one that would catch a regression to a bare `onConflictDoNothing()`.
- **`taken` includes tombstones** (§4 trap 2). Release a handle, then mint a _new_ agent whose name derives onto it, and assert it gets the suffixed form rather than the tombstoned one. This is the path 48 of 52 agents take, so D4 is worth nothing if it is not enforced here.
- **Seeding runs before anything can be minted** (§4a). Boot an install whose only agent has manifest `name: 'DorkOS'`, join it to a room, and assert it holds `dorkos-2` and the system author holds `dorkos`. Run the same test with the join _before_ any notice has ever been written, because that is the ordering the lazy version failed.
- **The three broadcast words are unclaimable** (§1). Deriving or requesting `everyone`, `here` or `channel` refuses with `HANDLE_RESERVED`.
- **Tombstone matching is case-folded** (§3). A tombstone written as `Ana` — which the grammar forbids but a direct write could produce — still blocks a claim for `ana`.
- **`resolve` does not refresh `handle`** (D12). Mint an agent author, change the manifest name to something else, resolve again, assert the handle is unchanged while `displayName` is. This is the regression that would silently undo the feature.
- Claiming a live handle throws `HANDLE_TAKEN`; claiming another author's tombstone throws `HANDLE_RESERVED`; claiming your own tombstone succeeds and deletes the row.
- The empty string never reaches the column, from any path.
- `handleFor` and the picker's source agree over a table of authors — **the G5 assertion**, and the one Buzz fails. Deriving "what reaches this author" twice is the failure mode; the test is what stops a future refactor reintroducing it.
- `resolveMentions` after the collapse: `@mio-clicker-pm` resolves; `@Mio Clicker PM` does not; `@MIO-CLICKER-PM` resolves (input lowercased); a handle that is a prefix of another (`@ana` with `ana-b` present) resolves to `ana` and not `ana-b`.
- **`mentionSpans` end at the handle, not at the punctuation** (§7). The example must include a trailing-shave case, because the obvious one hides the bug: for `` `Ping @ana. and @bo, thanks` `` assert `text.slice(start, start + length)` is `@ana` and `@bo` — not `@ana.`. A span built from `match[0].length` passes the `@bo,` half and fails the `@ana.` half.
- Backfill idempotency: run twice over a fixture holding one row of each shape (already-legal, needs-lowercasing, needs-derivation, the `'You'` human, the system author), and assert the second run writes nothing and suffixes do not advance.

**Client — jsdom**

- The picker offers a handle for every roster member and the `'No @name'` disabled row does not appear.
- `RoomEntryRow` renders a chip per span and plain text for an `@token` with no span.
- **A chip's label follows a rename**: same entry, roster updated with a new display name, re-render, assert the chip reads the new name and `entry.body.text` is byte-identical.

**Browser — `apps/e2e`**

One scenario, because it is the one jsdom cannot see: type `@`, arrow to a member, Enter, send, and assert the sent message addresses that member — the menu-to-editor focus race the room-participation spec already flags as having bitten this repo (`specs/room-participation/02-specification.md` §10.1). Plus hovering a chip opens the card.

**Mocking.** `FakeAgentRuntime` and the `@dorkos/test-utils` scenarios as today; no new fake is needed, because a handle is a column and not a port.

## Performance Considerations

Nothing here is on a hot path, and one thing gets faster.

**Resolution gets cheaper.** `claimNames` builds a `Map` over every name of every roster member on **every post** (`mentions.ts:69-78`, called from `room-service.ts:587`). After the collapse it is one entry per member instead of up to two, and `advertisedHandle`'s per-member scan over the claims map disappears from every roster read (`room-roster.ts:128-137`).

**Uniqueness is an index lookup**, on a table with one row per entity that has actually been in a room — six on this machine, and bounded above by the agent roster.

**Derivation is mint-time only.** It runs once per author, ever. The de-collision loop is bounded by the number of handles sharing a stem, which at this scale is one or two.

**Spans cost one array per entry**, computed inside the pass that already walks the string. The client's chip render is a linear splice over a body it already has.

**The backfill is six rows**, in one transaction. It does not scale with the agent roster, because `authors` is mint-on-first-use.

## Security Considerations

**Impersonation is the threat this feature both creates and closes.** An address that reliably reaches one entity is worth attacking; today's non-addresses are not.

- **Homoglyphs are eliminated, not detected** (§1). The charset cannot express a Cyrillic `а`, a fullwidth `ａ`, or an invisible joiner. Matrix takes the detection road and has a `Security`-labelled hole exactly there, because a lookalike never string-collides and disambiguation never fires (element-web #5826). The grammar is checked at one point; a filter would have to stay current against an adversary forever.
- **Reuse is closed by the tombstone** (§3). This is the GitHub failure mode — a released name reclaimed by someone else, with a mitigation that covered only the popular fraction of the namespace and was bypassed four times in two years.
- **The room's own voice cannot be impersonated** (S2, §4a). `dorkos` is seeded onto the system author **at boot**, beside `ensureDorkBot`, so an agent whose manifest name is `DorkOS` cannot win a race to it. Seeding lazily — which is what `system()`'s single notice-path caller would have done — fails open on ordering, and that is the class of bug a reservation exists to prevent, so it cannot be left to the same mint-on-first-use path as everything else.
- **A broadcast word cannot be farmed.** `everyone`, `here` and `channel` are seeded alongside it (§1), because a model writes `@everyone` whether or not that is our spelling for a broadcast, and an unreserved `everyone` is a name an adversarial agent could claim precisely to harvest broadcast-intent messages.
- **No new machine-writable surface.** Handle changes are human-initiated only (S6): no MCP tool, no capability, no agent-reachable route. An agent that could rename itself in a loop could exhaust a stem and grow the tombstone table; removing the mechanism is better than throttling it.
- **`sanitizeIdentity` is unchanged and still required.** It is the prompt-injection defence for labels rendered outside the untrusted fence (`untrusted-text.ts:1-27`) and it protects `display_name`, which stays unrestricted. A handle passing through it is a no-op by construction, which is the correct relationship: the grammar does not replace the sanitizer, it just gives the sanitizer nothing to do on this field.
- **`natural_key` still never reaches the wire.** A handle is derived from a display name, never from a path (`author-registry.ts:82-91`). An agent reading its own room's roster learns handles, not where anyone lives.
- **A handle is an address, never an authorization.** Nothing branches on it. Membership, `isOwner` (`author-registry.ts:337-344`) and the tier gate are unchanged and keep reading ids.

## Documentation

- **`docs/`** — the rooms concept page gains a short "Handles" section: what one is, how yours is set, that changing it is safe, and that the one you leave stays yours. Written to the `writing-for-humans` bar.
- **`contributing/`** — no new guide. The rooms architecture notes gain a paragraph pointing at `packages/shared/src/handle.ts` as the single grammar.
- **In-code** — the TSDoc in §1–§3 and §7 is the design record; there is no ADR (§Related ADRs).
- **Changelog** — one fragment per phase in `changelog/unreleased/`, at release, not on this documentation branch.
- **`mentions.ts:28-35`** — the two falsified sentences are corrected in a follow-up ticket, not here.

## Implementation Phases

**Phase 1 — the agent is told an address that works (DOR-675).** No schema. `handleFor` returns `string | null` and only ever a round-tripping name; `RoomContextMember.handle` becomes nullable; `room-context-block.ts` renders a handle-less member without an `@`; a test pins `handleFor` and the picker's source in step. **Independent of Phases 2–3 and worth shipping alone**, because it turns a silent wrong answer into a visible absent one. _(Correction to the framing this work started from: unresolved text does not currently render as a styled mention — the room body renders through `MarkdownContent` → `Streamdown` (`RoomEntryRow.tsx:80-82`) and there is no mention styling in the client at all. The rule that only resolved mentions become chips is therefore something Phase 2/3 builds in from the first commit, not a bug Phase 1 fixes.)_

**Phase 2 — `authors.handle` (DOR-676).** `packages/shared/src/handle.ts`; the column, both indexes and `handle_tombstones`; the boot-time seeding of `dorkos`/`everyone`/`here`/`channel` (§4a); the qualified conflict target (§4); derivation at mint; the idempotent backfill; **the human's handle prompt** (§4 — it does not wait for Phase 3); the three typed errors; `PATCH …/handle`; **the collapse** — `claimNames`, `advertisedHandle` and `mentionHandle` deleted, `namesFor` returning `[handle]`; the picker reading `AuthorRef.handle`; `mentionSpans` on write. **The acceptance criterion is the wiring, not the column** (G5): Buzz has the column.

**Phase 3 — the human surface (DOR-677).** Handle _editing_ in settings; avatar upload against the existing `user.image`; the mention chip; the hover card; the profile drawer. The initial handle _capture_ is not here — it ships in Phase 2, because a default that outlives its phase is not a default, it is the answer.

## Open Questions

All six ideation questions are resolved. Kept with their original framing as an audit trail.

- ~~**1. Does the system author get a handle, or is it deliberately unaddressable?** (RESOLVED)~~ — **Answer:** yes, `dorkos`, **seeded at boot**. **Rationale:** not to make it addressable (it is already excluded from the picker and un-triggerable) but to reserve the name, so an agent whose manifest name is `DorkOS` cannot take `@dorkos` and be addressed as the room itself. The first draft said "minted with the row" and "no special case anywhere" — **that was wrong and failed open**: `system()` has one production caller, the notice path, so on a fresh install the row does not exist until the first notice fires, and an agent joining before that wins the race. §4a has the fix. See S2.
- ~~**2. Handle length: 2–32, or shorter?** (RESOLVED)~~ — **Answer:** 2–32. **Rationale:** our scale argues for no bound at all, so the tiebreak is that a shipped, tested-at-scale bound beats an invented one. `handle` is deliberately a different grammar from `agents.name` (1–64) — and, per S3b, a different normalizer too: reusing `slugifyAgentName` was measured to change four working addresses out of 52. See S3, S3b, S3c.
- ~~**3. What does the de-collision suffix look like, and is a derived handle flagged?** (RESOLVED)~~ — **Answer:** a decimal counter (`-2`, `-3`), no flag. **Rationale:** an unmemorable random suffix is the Discord failure; a counter is predictable and at ~50 entities will rarely reach two digits. No flag, because the surface that would carry it already carries the edit affordance. See S4.
- ~~**4. Does `mentionHandle` survive alongside `handle`?** (RESOLVED)~~ — **Answer:** no; it collapses into `AuthorRef.handle`, and answering this forced the larger S1 decision to delete display-name addressing entirely. **Rationale:** `mentionHandle` was roster-relative because display-name ownership was; a unique index makes ownership global. See S1, S5, §5.
- ~~**5. Is a handle change rate-limited?** (RESOLVED)~~ — **Answer:** no, because no automated path can change one. **Rationale:** removing the mechanism beats throttling it. Handle writes are human-initiated only — no MCP tool, no capability, no agent-reachable route — which is an invariant with a test rather than a throttle with a tuning parameter. See S6.
- ~~**6. Should an unresolved `@token` produce a room notice?** (RESOLVED)~~ — **Answer:** no. **Rationale:** it would fire on prices and email addresses, which `mentions.ts:10-11` already anticipates, and the room's notice budget is already carefully damped. Phase 1 removes the only case where an unresolved token was a system error rather than prose. See S7.

## Related ADRs

**Constraining this work:**

- `260726-170126` — author identity is keyed on the agent's directory. A handle is an address on top of that key, never a replacement for it.
- `260726-170125` — a room is a membership-scoped durable stream.
- `260728-022013` — a thread is a relation between entries. Untouched; a thread reply resolves mentions through the same path.
- `0043` — the file is the canonical source of truth for the mesh registry. **This is why D12 exists**: the reconciler rebuilds `agents` from disk, so a re-derived handle would be silently overwritten.
- `260727-184933` (D6) — single-user local install, which is why "the human" is singular throughout.

**No ADR is written by this spec.** These are product and schema choices inside one already-decided domain. Two would be extracted if they prove contentious:

1. **D4, permanent tombstoning.** An unbounded-lifetime policy with a security rationale that disagrees with GitHub's published position. If anyone later proposes expiring tombstones, that argument deserves a record.
2. **D5, broadcast keywords as a separate token type.** It constrains a feature that does not exist yet, which is exactly the kind of decision a future implementer will want the reasoning for rather than the rule.

## References

- **Research:** `research/20260728_handle-systems-prior-art.md` — full survey, every claim cited, with an explicit list of what could not be verified.
- **Specs:** `specs/handles/01-ideation.md` · `specs/room-participation/02-specification.md` (§10.1 RP5, §10.2 RP6) · `specs/community-adapter/02-specification.md` (remote identity) · `specs/accounts-and-auth/02-specification.md`
- **Tracker:** DOR-675 (Phase 1) · DOR-676 (Phase 2) · DOR-677 (Phase 3). **Shipped work:** DOR-631 / `3f4b8f036` — the `@` picker, which exposed this.
- **Slack:** [The one about usernames](https://docs.slack.dev/changelog/2017-09-the-one-about-usernames/) · [Formatting text for app surfaces](https://docs.slack.dev/messaging/formatting-message-text)
- **Discord:** [Evolving Usernames on Discord](https://discord.com/blog/usernames/) · [User Resource — Usernames and Nicknames](https://docs.discord.com/developers/resources/user)
- **Matrix:** [Appendices — User Identifiers](https://spec.matrix.org/latest/appendices/#user-identifiers) · [Calculating the display name for a user](https://spec.matrix.org/latest/client-server-api/#calculating-the-display-name-for-a-user) · [element-web #5826](https://github.com/vector-im/element-web/issues/5826)
- **GitHub:** [New tools for open source maintainers](https://github.blog/2018-04-18-new-tools-for-open-source-maintainers/) · [Checkmarx on repojacking](https://checkmarx.com/blog/github-repojacking-weakness-exploited-in-the-wild-by-attackers/)
- **Buzz** @ `55a3ed7b9217cee5b23e0a5441947dc929b2a38c`: `migrations/0001_initial_schema.sql`, `crates/buzz-sdk/src/mentions.rs`, `crates/buzz-db/src/user.rs`, `crates/buzz-cli/src/commands/messages.rs`, `crates/buzz-relay/src/api/nip05.rs`, `crates/buzz-relay/src/handlers/side_effects.rs`, `NOSTR.md`
