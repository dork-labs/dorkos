---
slug: chats-as-channels
id: 260803-133357
created: 2026-08-03
status: specified
---

# Specification: Chats as Channels — a bound external chat becomes a DorkOS channel

- **Slug:** chats-as-channels
- **Id:** 260803-133357
- **Status:** specified
- **Date:** 2026-08-03
- **Author:** SPECIFY stage (directed by Dorian)
- **Tracker:** DOR-862 (umbrella)
- **Revision:** rev 2, 2026-08-03 — three blockers and eight majors from adversarial review applied; the five open questions closed at the founder gate. `design-decisions.md` §D-6 records those answers.
- **North Star:** [`meta/agent-etiquette.md`](../../meta/agent-etiquette.md) and [`.claude/rules/room-conduct.md`](../../.claude/rules/room-conduct.md). Nothing here may weaken a mechanism either of them names.
- **Parent programme:** Move 3 of the Connection-scoping model in [`plans/language-ia-simplification.md`](../../plans/language-ia-simplification.md) §"Phase 3 design decisions" item 3. Moves 1 and 2 ship **before** this — §2.3 lists exactly what is consumed. Sequencing is Option A (item 4).
- **Decisions already made:** [`design-decisions.md`](./design-decisions.md) beside this file. Cite that file in DECOMPOSE for founder rationale; cite this one for how the code works.
- **Anchor:** `main` @ `e6c4dcf07`, 2026-08-03. Every `file:line` below was read at that commit.

---

## Overview

A Telegram chat that is bound to an agent today is a **private pipe**: the message goes to one session, the session answers, and nothing that happened is visible to any other session, any other agent, or the person's cockpit. Bind a second agent, or start a second session, and the two know nothing of each other.

This spec makes a bound external chat **project into a DorkOS channel**. Inbound platform messages become room posts. The room's existing per-`(room, agent)` turn machinery answers them. Any session of the bound agent that posts into the room has its post delivered back out to the platform. The room log — durable, DorkOS-owned, never trimmed — is the single shared history every future turn reads.

One sentence of design: **the room is the chat's memory, and the platform is one of its windows.**

That is the thing no surveyed product does. Every product that connects an agent to a chat keys the session on the chat identifier — "the chat IS the thread" — and therefore cannot let a second worker speak into that chat coherently ([`research/20260803_connection-scoping-prior-art.md`](../../research/20260803_connection-scoping-prior-art.md) §"The continuity/history problem"). DorkOS already owns a durable, multi-participant, mixed-runtime stream (ADR `260726-170125`). Bridging into it is a small amount of plumbing on top of a primitive nobody else built.

## Background / Problem Statement

Five facts about the code today, verified at the anchor commit:

1. **The bridge seam exists and is empty.** `packages/relay/src/adapters/telegram/outbound.ts:527-529` says so in its own words: "No such bridge exists yet: room presence is published to the room's own event stream (`RoomService.publishSignal`) and reaches the cockpit, not a relay adapter." `.claude/rules/room-conduct.md` lists it as the one remaining known gap.
2. **An inbound chat message never touches a room.** `BindingRouter.handleInbound` (`apps/server/src/services/relay/binding-router.ts:379`) resolves a binding, resolves a session from its own `sessionMap`, and republishes to `relay.agent.<runtimeType>.<sessionId>`. Rooms are not in that path.
3. **Continuity is a per-chat session map, and it is capped and evictable.** `BindingRouter` persists `{relayDir}/sessions.json` and evicts past `MAX_SESSIONS` (`binding-router.ts:794-800, 856-860`). The `per-chat` strategy keys one session per `(binding, chatId)`; a second session of the same agent shares nothing with it.
4. **Rooms already do the hard part.** `RoomTriggerDispatcher` claims one turn per `(room, agent)`, runs it, posts the answer, and posts a **late** answer when the turn outruns the room's wait (`room-trigger.ts:917-990`, late delivery at `room-trigger.ts:983+`). Room framing is structured `room_context` (ADR-0273), fenced per turn (`services/runtimes/shared/room-context-block.ts`).
5. **Nothing marks an external stranger.** Room context distinguishes person from machine (`RoomContextMember.isPerson`, `packages/shared/src/additional-context.ts:160-176`) but has no concept of "this person is not from this machine."

Two user-visible problems follow: the **many-sessions-one-chat gap** (Telegram and the cockpit are two conversations that contradict each other), and the **invisible chat** (a conversation with your own agent, on your own machine, readable only inside Telegram).

## Goals

- A bound chat, once bridged, has **one durable history** every session of the bound agent reads before it speaks.
- **Any** session of the bound agent can speak into that chat by posting to the room.
- Inbound messages are **deduplicated** and appear in the room in the order the bridge accepted them, exactly once.
- An **external** author is visibly external in the roster, in the cockpit, and in every model's context — and their words are inside the untrusted fence.
- The channel tells the truth about what the bot can see, sourced from the platform.
- Group behaviour respects `meta/agent-etiquette.md`: mention-gated by default.
- Wire schemas, the subject grammar, the adapter contract, and the runtime seam do not change (§11 states exactly what "does not change" means, and what is additive).

## Non-Goals

- **Any platform other than Telegram in phase 1.** Slack is phase 3, designed for but not built.
- **Telegram forum topics as separate rooms** (folded in phase 1 — §5.6, D-6 Q1).
- **A second turn-triggering path.** The bridge writes a post and stops.
- **Any change to who runs a turn**, to arbitration (there is none — ADR `260726-170125`), the cascade guard, the turn budget, or the halt path.
- **Editing, reactions, deletion round-tripping** (§10.6).
- **Bridging unclaimed chats** (§3.1).
- **Media payloads.** Non-text messages land as labelled placeholders (§5.5); no bytes are downloaded or given to a model.
- **Multi-agent bridged rooms** (§3.4, D-6 Q3).
- **Retroactive import of platform history.** Telegram exposes no history read to bots.

## Technical Dependencies

None new. Everything rides shipped machinery:

| Seam                                                                         | Where                                                                                      | Used for                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Relay subject grammar `relay.human.{platform}.{instanceId}[.group].{chatId}` | `services/relay/human-subject.ts:36-63`                                                    | Bridge keying, both directions                   |
| `BindingStore.resolve(adapterId, chatId, channelType)`                       | called at `binding-router.ts:426`                                                          | Which binding owns a chat                        |
| `RoomService.post` / `postNotice`                                            | `services/rooms/room-service.ts:686-800`                                                   | Inbound → room, room's own voice                 |
| `RoomTriggerDispatcher.dispatch` + claim map                                 | `services/rooms/room-trigger.ts:313, 258-296`                                              | Turn selection, one turn per `(room, agent)`     |
| `deliver` / late delivery                                                    | `room-trigger.ts:917-990, 983+`                                                            | Answers, including late ones                     |
| `AuthorRegistry.resolve({kind, naturalKey, displayName})`                    | `services/rooms/author-registry.ts:181`                                                    | Minting an external human author                 |
| `buildRoomContext` + `formatRoomContext`                                     | `services/rooms/room-context.ts:140`, `services/runtimes/shared/room-context-block.ts:522` | Structured, fenced injection, all three runtimes |
| `createInitiateConsentGate`                                                  | `services/relay/initiate-consent.ts:208`                                                   | Outbound consent (extended — §6.6)               |
| `handleTypingSignal`                                                         | `packages/relay/src/adapters/telegram/outbound.ts:537`                                     | Room presence → Telegram typing                  |
| Telegram `getMe().can_read_all_group_messages`                               | Bot API                                                                                    | Privacy-mode truth (§8)                          |

---

## 1. Vocabulary, and the one rule

| Word                | Means, in this spec                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **chat**            | The thing on the platform: a Telegram private chat, group, or supergroup.                                                                       |
| **channel**         | The DorkOS room the chat projects into. User-facing word (language plan D1).                                                                    |
| **bridge**          | The projection, and the durable row recording it. One bridge = one `(adapterId, chatId)` ↔ one room.                                            |
| **chat claim**      | Move 2's act of pointing an unbound chat at an agent. Never abbreviated to "claim" — that word is taken by the turn claim in `room-trigger.ts`. |
| **turn claim**      | The dispatcher's in-flight `(room, agent)` claim.                                                                                               |
| **external author** | A person who wrote into the chat from the platform.                                                                                             |
| **projection**      | One-directional copying with provenance. Never a sync: the room is authoritative, the platform is a window.                                     |

**The one rule: the bridge writes and reads room entries; it never triggers a turn.** Every decision about whether an agent answers stays in `addressing.ts`, `cascade-guard.ts`, `turn-budget.ts`, and the dispatcher.

---

## 2. Codebase map, and what Moves 1–2 must have landed

### 2.1 The inbound path today

```
Telegram update
  → adapters/telegram/inbound.ts
      isBotSender gate
      shouldProcessGroupMessage(mode, message, me)   :235-244   ← GROUP GATE, pre-publish
      buildSubject(resolvedCodec, chat.id, isGroup)  :424
      captionless media dropped ("no text content")  :427-430
      payload.responseContext.formattingInstructions = TELEGRAM_FORMATTING_RULES  :460-465
      payload.platformData { chatId, messageId, chatType, fromId, username } :470-476
  → relay.publish(subject, payload, { from: '{prefix}.bot', replyTo: subject })
  → BindingRouter.handleInbound   :379
      resolve binding  :426 → checks enabled / canReceive / agent in mesh
      resolveSession(binding, chatId, envelope)   ← per-chat sessionMap
      publish relay.agent.<runtimeType>.<sessionId>
  → runtime adapter runs the turn; reply republished to envelope.replyTo under `agent:*`
  → outbound.ts sends it to the chat
```

**`shouldProcessGroupMessage` is load-bearing for §5.4 and is named here so nothing downstream forgets it.** `DEFAULT_RESPOND_MODE` is `'thread-aware'` (`packages/shared/src/relay-adapter-schemas.ts:98`), so in the shipped default an unaddressed group message that is not a reply to the bot is dropped **before publish** — it never reaches the relay, the router, or a room.

### 2.2 The room path today

`RoomService.post` (`room-service.ts:686`) requires membership, resolves addressing once at write time (`:718`), appends the entry, publishes it (`:740` → `publishEntry`, `:1232`), and calls `this.triggers.dispatch(...)` inside a `try` so a committed post is never lost to a dispatch failure (`:754-770`).

`publishEntry` goes through `RoomBroadcaster` (`room-stream.ts:40`), which is a **live fan-out** — it drops events for absent subscribers. §6.1 therefore drives delivery off the durable log, never off that stream.

### 2.3 What this spec consumes from Moves 1 and 2

Assumed present, not built here: chat claim as a first-class act; one-chat-one-agent uniqueness with an explicit move dialog; adapter and binding created atomically in the wizard; `BindingStore.resolve` filtering `enabled`. If Move 2 slips, phase 1 still lands via the "Bridge to a channel" action on an existing binding; only §3.1's claim-card entry point goes with it.

**Acceptance criteria (§2)**

- **A2.1** A bridged binding never reaches session dispatch — asserted with a spy on the session creator, not by reading order.
- **A2.2** A bridged room's turn goes through `RoomTriggerDispatcher`, asserted by observing a turn claim, not a runtime call.
- **A2.3** With `respondMode` at its `'thread-aware'` default, an unaddressed group message produces no relay publish at all — pinning §5.4's precondition at the adapter, where it actually lives.

---

## 3. Room projection lifecycle

### 3.1 Creation — a room appears at chat claim, never before

A room is created for a chat when, and only when, **a person claims that chat and chooses to bridge it**. Two entry points, one code path: the claim card's primary action ("Answer in a channel"), and a "Bridge to a channel" action on an existing binding in the Connections › Messaging detail sheet. The secondary claim action ("Answer privately") is today's session-per-chat behaviour, no room.

Until a chat is claimed there is no room, no author row for the stranger, no entry, and no agent run.

**A bridge is a mode on the binding plus a durable bridge row.** `AdapterBindingSchema` (`packages/shared/src/relay-adapter-schemas.ts:446`) gains:

```
bridge:  z.enum(['off', 'room']).default('off')   // the feature flag, per chat
roomId:  z.string().nullable().default(null)      // set iff bridge === 'room'
```

Both are added to `UpdateBindingRequestSchema` as well, or the cockpit cannot flip them.

The **bridge row** (`room_bridges`) is the identity record and outlives the flag:

```
roomId              TEXT NOT NULL UNIQUE
adapterId           TEXT NOT NULL
chatId              TEXT NOT NULL
channelType         TEXT                     -- from the subject
platformChatType    TEXT NOT NULL            -- 'private' | 'group' | 'supergroup'
bindingId           TEXT NOT NULL
visibility          TEXT                     -- §8
visibilityCheckedAt TEXT
deliverNotices      INTEGER NOT NULL         -- §6.2, seeded by room kind
lastDeliveredSeq    INTEGER NOT NULL DEFAULT 0   -- §6.1 catch-up
lastActivityAt      TEXT                     -- §7.5
createdAt, archivedAt
UNIQUE (adapterId, chatId)
```

Defaulting `bridge` to `'off'` is what makes this shippable without a global flag and without a `~/.dork/config.json` migration: every existing binding behaves exactly as today, and the field is the flag.

A binding with `bridge: 'room'` **must** carry a `chatId`. A chat-wildcard binding (no `chatId`, which `BindingStore.resolve` treats as matching every chat on the adapter — `initiate-consent.ts:196-203`) cannot be bridged: one room cannot honestly be "the" channel for an unbounded set of chats. Attempting it is a validation error naming the reason.

### 3.2 Room identity is the bridge row — never a member set

**This is the single most important structural correction in this spec.** `RoomStore.findDmByMemberSet` (`room-store.ts:197-218`) matches a DM by its exact member set, and `createRoom` consults it for every `kind: 'dm'` request (`room-service.ts:386-398`), returning — and un-archiving — the match. A bridged private chat whose roster is `{operator, bound agent}` is **byte-identical** to the operator's own private DM with that agent. Creating one would silently return the operator's existing private conversation, land strangers' messages in it, and make its private posts delivery candidates for a chat the operator never meant to expose.

So:

- **The bridge create path does not go through member-set matching.** It calls a dedicated `RoomService.createBridgedRoom(...)` (or `createRoom` with an explicit `dedupe: false` flag — either is acceptable; the property is what matters) which mints a room unconditionally.
- **Re-bridging resolves through the bridge store**, on `(adapterId, chatId)`, never through the roster. That is what makes re-bridging idempotent, and it is idempotent on the _chat_, which is the natural key that actually identifies this room.
- **`findDmByMemberSet` never returns a bridged room.** It gains a `WHERE rooms.id NOT IN (SELECT room_id FROM room_bridges)` clause — enforced in the query, not by convention, because a future caller will not know to avoid it.

Consequently a person can have both a private DM with `ana` and a bridged Telegram DM that `ana` answers, and the two are different rooms with different logs.

### 3.3 Kind mapping

| Telegram `chat.type`  | `channelType` on the subject | Room `kind` | Room identity                                                                                        |
| --------------------- | ---------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `private`             | (absent — DM subject)        | `dm`        | The bridge row's `(adapterId, chatId)` — §3.2                                                        |
| `group`, `supergroup` | `group`                      | `channel`   | The bridge row; the slug is cosmetic (§3.4)                                                          |
| `channel` (broadcast) | `group`                      | —           | **Refused.** A broadcast channel is not a conversation. The claim card offers only "Ignore"/"Leave". |

Read from `platformData.chatType`, classified at `adapters/telegram/inbound.ts:349`, stored as `platformChatType` so nothing re-derives it.

`dm` is the kind for a bridged private chat (D-6 Q2), which is safe **only** because of §3.2. If §3.2's dedupe bypass proves invasive during implementation, the recorded fallback is kind `channel` — the founder pre-approved that swap rather than any weakening of §3.2.

### 3.4 Roster, and the atomic mention-only seed

A newly bridged room is created with:

- the **bound agent**, with `responseMode` written explicitly at join: the manifest default for a `dm`, **`mention-only`** for a bridged `channel`;
- the **operator** (local human author), so the person can speak into their own bridged chat from the cockpit without a join step;
- **no external humans** — they are minted on first message (§4.2).

**The `mention-only` seed cannot be a follow-up write.** `RoomRoster.seedResponseMode` returns `CHANNEL_RESPONSE_MODE = 'engaged'` for channels (`room-roster.ts:37, 208-212`), and `engaged` answers ordinary chatter inside a window — the exact over-participation D-3 forbids in a bridged group. A create-then-patch sequence leaves a window in which the agent is `engaged` in a chat with strangers.

Two acceptable implementations; pick one in DECOMPOSE:

1. `CreateRoomRequest` carries an optional per-member `responseMode`, resolved inside `createRoom`'s single transaction alongside `seedResponseMode`; or
2. the room is fully created **and** configured before `binding.bridge` flips to `'room'` — the flag flip is the last write, so a failure anywhere earlier leaves an unbridged binding and an orphan room the next start reaps.

Either way the invariant is: **there is no observable instant in which a bridged group room has a bound agent that is not `mention-only`.**

Exactly one agent is in the roster. A second is refused in phase 1 with a notice naming why (D-6 Q3: outbound consent is per binding, and a second agent's delivery has no gate that names it — `checkSender` would correctly deny, producing a half-silent room).

The bridge creates the room as the operator author, so `requireOperator` on `addMember` (`room-service.ts:588-593`) and `requireSeedingAllowed` are satisfied by the person's own authority, not by an exemption.

**Titles and slugs.** A `dm` room's title is the external person's display name, sanitized (§9.2). A `channel` room's title is the platform chat title, sanitized; its slug is `slugify(title)`, and on collision with a live channel (`room-service.ts:348-353` throws `SLUG_TAKEN`) the bridge appends `-2`, `-3`, … until free. A platform title change does **not** rename an existing room (`room-service.ts:317-321`); the room sheet shows the current platform title as a subtitle so the two never silently diverge.

### 3.5 Unbinding and archival

| Event                                                                | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bridge switched `room` → `off`                                       | Room **archived**; a notice records that the chat is no longer connected; `binding.roomId` cleared. **The bridge row and every external ref survive** — only `binding.bridge` flips and `archivedAt` is stamped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Binding deleted                                                      | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Bot blocked / kicked (§10.3)                                         | Same, with the platform's own reason in the notice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Re-bridged for the same `(adapterId, chatId)`, same agent            | The surviving bridge row is found, its room **un-archived and reused**, `archivedAt` cleared. Echo suppression and reply targeting keep working because the refs were never deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Re-bridged for the same `(adapterId, chatId)`, **a different agent** | The surviving row's `UNIQUE (adapterId, chatId)` makes a second row impossible, and that is the right answer rather than an obstacle: **the rebind adopts the surviving bridge row and its room**, re-pointing `bindingId` and swapping the roster's bound agent. The room **is** the chat's history, and minting a parallel room would strand it — the same reasoning `createRoom` applies to a re-opened DM (`room-service.ts:314-318`). Three consequences, all stated in a notice posted into the room at the swap: the new agent inherits the full room log as ambient history and reads every prior message, including the old agent's; the old agent leaves the roster and its `(room, agent)` session is dropped from the ledger, so its private transcript is orphaned rather than migrated; and the room keeps its id, title, slug and every external ref, so echo suppression and reply targeting stay continuous across the swap. A person who wants a clean start un-bridges, archives the room, and bridges fresh — the destructive option stays explicit. |
| Agent unregistered from the mesh                                     | Room stays; the existing `agent_gone` notice path reports it. No new behaviour.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Archive is the only removal. The room log is never trimmed (ADR `260726-170125`).

**Acceptance criteria (§3)**

- **A3.1** An inbound message from an unclaimed chat creates no room, no author, no entry, and runs no turn — asserted on the store.
- **A3.2** Bridging the same `(adapterId, chatId)` twice returns one room, resolved through the bridge store.
- **A3.2b** Bridging a private chat to an agent the operator **already has a private DM with** creates a second, distinct room. The operator's private DM is untouched: same id, same roster, same entry count, not un-archived, and never a delivery candidate.
- **A3.2c** `findDmByMemberSet` never returns a bridged room — asserted directly against the query, with a bridged room whose member set matches the requested one.
- **A3.3** A bridged group room's bound agent is `mention-only` at every observable point, **including after a simulated failure of the second step** of whichever implementation §3.4 picks.
- **A3.4** A slug collision produces `#name-2`, never an error.
- **A3.5** `bridge: 'room'` with no `chatId` is rejected at the schema/route boundary with a message naming the wildcard reason.
- **A3.6** Un-bridging archives and preserves the bridge row and refs; re-bridging to the **same** agent un-archives the same room id and appends to the same log.
- **A3.6b** Re-bridging the same `(adapterId, chatId)` to a **different** agent adopts the surviving bridge row and its room: same room id, roster's bound agent swapped, old agent's ledger entry dropped, external refs intact, and one notice posted naming the swap. On a bridged **channel**, the swapped-in agent is `mention-only` **at every observable point** — the same invariant §3.4 sets at creation, and it holds for the same reason: `RoomRoster.add` takes `input.responseMode` and falls back to `seedResponseMode` only when the caller supplies none (`room-roster.ts:80`), so the swap path seeds the mode **atomically in the add**, never as a follow-up patch. Asserted after a simulated failure of any step following the add.
- **A3.7** A broadcast-channel chat cannot be bridged.

---

## 4. External member identity

### 4.1 The author model already fits

`AuthorRegistry.resolve` mints on `(kind, naturalKey)` (ADR `260726-170126`, `author-registry.ts:181`). A Telegram sender is a **human** — `RoomContextMember.isPerson` must say so or the etiquette rules become unfollowable.

**Natural key:** `platform:{platformType}:{instanceId}:{platformUserId}` — e.g. `platform:telegram:tg-main:145223`. Opaque and address-free; scoped to the adapter instance so two bots cannot collide; stable across display-name changes. The `platformUserId` comes from `platformData.fromId`, parsed by the existing `extractPlatformUserId` (`binding-router.ts:57-88`) — do not write a second parser.

**Invariant:** no locally minted author's natural key may begin `platform:`. The three local kinds are `local`, `user:{id}`, and an agent path; none can spell the prefix, and a test pins that they never will.

**A message with no resolvable platform user id gets no author** and is dropped with a refusal line, rather than folded into a shared "someone" author that would merge two strangers into one identity in a log meant to be evidence.

### 4.2 Joining the roster

An external human is added on their **first message**, in the same transaction that writes their first entry — not at bridge time, so a group of 200 does not project 200 rows for people who never spoke. Added by the bridge acting as the operator author, satisfying `requireOperator`. Their membership `responseMode` is the inert default `seedResponseMode` already returns for non-agents (`room-roster.ts:44, 208-209`).

### 4.3 Origin, and where it comes from

`RoomRosterEntry` and `RoomContextMember` gain:

```
origin: 'local' | { platform: string }
```

**Derived from the stored author's `naturalKey` prefix**, never from the relay subject at render time. Render-time derivation would mean the origin of a two-year-old entry depends on which subject happened to be in scope; the natural key is written once at mint and is the only honest source. `'local'` for the operator, agents, and the system voice; `{ platform }` for anything whose key starts `platform:`.

Every external member renders with an origin mark — the platform icon plus its name, e.g. "Miguel · Telegram" — in the roster, the room sheet, and beside each of their entries. It is the difference between "a person on this machine wrote this" and "a stranger on the internet wrote this," which §9 makes a security boundary.

### 4.4 Identity is per-install and does not travel

Two installs bridging the same group mint unrelated authors — the same honest limit ADR `260726-170126` records for agents, and the seam `CommunityAdapter` bridges when communities land.

**Acceptance criteria (§4)**

- **A4.1** Two messages from the same Telegram user in the same bridged chat resolve to one author row.
- **A4.2** The same Telegram user under two adapter instances resolves to two author rows.
- **A4.3** A display-name change on the platform updates the display name without minting a second author.
- **A4.4** `room_context` carries `isPerson: true` and `origin: { platform: 'telegram' }` for an external author, with origin derived from the stored key — asserted by rendering context with no live subject in scope.
- **A4.5** No locally minted author has a `platform:`-prefixed natural key.
- **A4.6** A group with N silent members has exactly one roster row per member who has spoken.

---

## 5. Inbound flow

### 5.1 The path

```
Telegram update
  → adapters/telegram/inbound.ts (see §2.1 gates; additive payload fields per §11.2)
  → relay.publish(relay.human.telegram.{instanceId}[.group].{chatId}, payload)
  → BindingRouter.handleInbound   :379
      resolve binding, enabled / canReceive / agent-in-mesh checks (unchanged)
      ── if binding.bridge === 'room' ──────────────────────────
         ChatBridge.ingest(binding, envelope)      ← NEW, TERMINAL
      ── else ─────────────────────────────────────────────────
         resolveSession → publish relay.agent.…    (unchanged)
```

`ingest` is **terminal** for bridged bindings. Falling through would run the turn twice from one message. Code lives at `apps/server/src/services/relay/chat-bridge/` — `ingest.ts`, `deliver.ts`, `bridge-store.ts`, `catch-up.ts`, `index.ts`.

### 5.2 What `ingest` does, in order

1. **Dedup.** Compute `{adapterId, chatId, platformMessageId}` from `platformData.messageId`. An existing row in `room_bridge_messages` stops here: refusal reason `duplicate_inbound`, no entry, no notice, no turn. Telegram redelivers on webhook retry and on a polling/webhook overlap during restart.
2. **Rate ceiling.** A per-`(adapterId, chatId)` inbound ingest ceiling (a rolling count over a short window). Past it, `ingest` **refuses** with a damped `bridge_rate_limited` notice in the room and nothing written. Refusing, not trimming: a trim policy would undermine the log's whole purpose, and the room already answers "an agent declined" with a visible notice rather than silence. The bound agent is protected anyway by the turn budget's two ceilings; this protects the _log_ and the disk.
3. **Resolve the room** from the bridge row. A `bridge: 'room'` binding whose room is missing is a broken bridge: log a refusal, tell the person in-chat through the existing `chatNotice` path, and **do not** create a room (a bridge whose room the person archived out-of-band must not resurrect itself).
4. **Resolve or mint the external author** (§4.1); add them to the roster if new (§4.2).
5. **Write the entry** through `RoomService.post` as that author. `post` resolves addressing, appends, publishes, dispatches. The bridge does nothing else.
6. **Record the external ref** — `(roomId, entryId, direction: 'inbound', chatId, platformMessageId, threadId?, threadName?)` — in the same transaction as step 5.

Steps 4–6 run in one SQLite transaction. `better-sqlite3` is synchronous, so that is a real transaction.

### 5.3 Ordering

The room log's `seq` is the order **the bridge accepted messages**, not the platform's clock. `ingest` is serialized per `(adapterId, chatId)` by an in-process promise chain, so two updates cannot interleave their transactions. Nothing reorders on platform timestamps: a log that silently reorders is worse evidence than one that is honestly append-only. Note this serializes _ingest_ — a few indexed writes — and never serializes turns, which the dispatcher already governs.

### 5.4 What triggers a turn, and the ambient tier's real precondition

Nothing new decides this. The entry is a normal room post and `RoomTriggerDispatcher` applies the existing rules:

| Room kind                   | Bound agent's `responseMode`          | Effect                                                             |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `dm` (bridged private chat) | manifest default (typically `always`) | Every message triggers a turn; naming is implicit in a DM.         |
| `channel` (bridged group)   | `mention-only` (§3.4)                 | Only a message resolving a mention for that agent triggers a turn. |

**The ambient tier is empty in the default posture, and this spec says so rather than implying otherwise.** Two independent gates sit upstream of the room:

1. **Telegram privacy mode**, ON by default for group-added bots — unaddressed messages are never delivered to the bot at all (§8).
2. **`shouldProcessGroupMessage`** (`packages/relay/src/adapters/telegram/inbound.ts:235-244`) with `DEFAULT_RESPOND_MODE = 'thread-aware'` (`relay-adapter-schemas.ts:98`) — even with privacy mode off, an unaddressed message that is not a reply to the bot is dropped **before publish**.

So: **ambient context in a bridged group exists only when privacy mode is OFF _and_ the adapter's `respondMode` is `'always'`.** In the shipped default posture the bridged group's room log contains **only bot-addressed messages** — mentions, replies to the bot, and commands. That is not a defect; it is the honest consequence of D-3's consent posture, and §8's badge ("sees mentions only") is precisely the description of it. The room log remains the shared history: a complete record of everything the bot received, which is what this spec actually promises.

**Mention resolution needs one platform translation.** Telegram addresses a bot as `@botusername`, which is not the agent's DorkOS handle. `ingest` rewrites nothing — the log holds exactly what the person typed — and instead threads one extra addressing candidate for the bound agent in that room, from `getMe().username`, through the existing chain: `RoomRoster.addressingCandidates` (`room-roster.ts:183`) → `rosterMentionCandidates` → `claimNames` (`author-handles.ts:161`). `claimNames` is **first-claimant-wins**, so the extra candidate is appended after the agent's own advertised handles and can never steal a name another member already claims. A reply to one of the agent's own messages also counts as addressing it, matching Telegram's own privacy-mode semantics.

### 5.5 Non-text messages

A photo, sticker, voice note, document, or location writes an entry whose text is a labelled placeholder — `[photo]`, `[voice message, 0:14]`, `[document: report.pdf]` — plus any caption, with the caption inside the same untrusted region as any other message text. No media bytes are downloaded, stored, or given to a model in phase 1.

**This requires lifting an existing drop.** `inbound.ts:427-430` returns early on `!rawText`, so a captionless photo is dropped before publish today. The adapter must publish it with media descriptors in `platformData` (§11.2); the placeholder is built server-side from those descriptors, never from adapter-authored prose. A placeholder is honest; silently dropping the message makes the room log disagree with the chat.

### 5.6 Forum topics

A message carrying `message_thread_id` lands in the same room. **Both the topic id and the topic name** are recorded on the external ref: the id so outbound delivery targets the right topic (§6.5), the name so each entry can render a **sanitized topic label outside the fence** (§9.2 — it is a label, not a message) in the cockpit and in `room_context`. Without the name, a folded room is an unreadable interleaving of several conversations.

Phase 1 does not separate topics into rooms or DorkOS threads (D-6 Q1: defer until Slack's `thread_ts` is in hand, so the choice is made once).

**Acceptance criteria (§5)**

- **A5.1** The same platform message id ingested twice produces one entry and one turn.
- **A5.2** A bridged binding never reaches `resolveSession` (spy on the session creator).
- **A5.3** Two concurrent inbound messages produce two entries with `seq` in acceptance order and no interleaved partial state.
- **A5.4** In a bridged group **with privacy mode off and `respondMode: 'always'`**, an unmentioned message writes an entry, triggers no turn, and appears in the next triggered turn's `room_context` as an unread entry. A sibling test asserts that in the **default** posture the same message never reaches the bridge at all (A2.3 pins the adapter half).
- **A5.5** In a bridged group, `@botusername hello` triggers a turn for the bound agent, and the extra candidate never displaces a handle another member already claims.
- **A5.6** A crash between entry write and external-ref write is impossible — the transaction test asserts both rows or neither.
- **A5.7** A **captionless** photo writes one placeholder entry; a captioned one writes placeholder plus caption.
- **A5.8** A `bridge: 'room'` binding with a missing room refuses with an in-chat notice and creates nothing.
- **A5.9** Past the per-chat ingest ceiling, `ingest` refuses, writes one damped `bridge_rate_limited` notice, and writes no entry.
- **A5.10** A forum-topic message's entry carries the topic id and a sanitized topic name.

---

## 6. Outbound flow

### 6.1 What delivers, and what drives delivery

A committed room entry is delivered when all of these hold:

1. the room has a live bridge;
2. `kind` is `post`, **or** it is a `notice` this bridge's §6.2 setting makes eligible;
3. the entry has no `direction: 'inbound'` external ref (echo suppression, §6.3);
4. the author is the **bound agent** or the **operator**;
5. the consent check in §6.6 passes.

**Delivery is driven off the durable room log, not off the live stream.** `publishEntry` → `RoomBroadcaster` (`room-stream.ts:40`) drops events for absent subscribers, so a bridge subscribed to it would silently lose every entry committed while the adapter was down or reconnecting. Instead:

- the bridge attempts delivery inline on commit (the fast path), and
- keeps `lastDeliveredSeq` on the bridge row; on start, on adapter reconnect, and after a delivery failure resolves, it **scans the bridged room for entries above `lastDeliveredSeq` that qualify under criteria 1–5 and lack an outbound ref**, and delivers them in `seq` order.

**The scan applies the same eligibility test as the inline path — including criterion 2's notice clause.** Scoping the scan to `kind: 'post'` would mean a `turn_failed` committed while the adapter was down never catches up, so the one notice a bridged DM exists to deliver would be the one notice that silently never arrives.

The scan is the authority; the inline attempt is an optimization. Idempotence comes from §6.3, not from the scan running at most once.

### 6.2 Notices

Room notices (`cascade_stopped`, `budget_reached`, `agent_busy`, `turn_failed`, `agent_gone`, `awaiting_approval`, `halted`) are cockpit-shaped, and two would leak (`agent_busy` deliberately says nothing about where; `agent_gone` names an agent the platform person has no relationship with).

`deliverNotices` is a per-bridge boolean, **seeded by room kind** (D-6 Q5): **`true` for a bridged `dm`**, **`false` for a bridged `channel`**, with a single per-bridge override. Scope when on is exactly `turn_failed` and `halted`, rendered as one plain sentence. The rationale is who is standing on the other end: a bridged DM is usually the operator's own account, and silence after a crashed turn is the failure `.claude/rules/room-conduct.md` exists to prevent; a bridged group is other people, who do not need this machine's internals.

**Amended 2026-08-18 (DOR-1359) — the scope is now four codes, not two.** `awaiting_approval` and `agent_busy` deliver as well. The paragraph above reads them as "cockpit-shaped", which held for `cascade_stopped` and `budget_reached` (this install's own limits) and for `agent_gone` and `agent_unavailable` (a registration and a database the platform person cannot act on), but not for these two: both say an agent has **stopped**, which is precisely what somebody waiting on a chat is missing. Both forward the room's stored words unchanged — the waiting line stays vague, late and damped, carrying no tool name, path or command — and neither is actionable from the chat. Making a bridged Ask answerable needs the approver-allowlist entitlement (`adapters/approver-allowlist.ts`), which is DOR-1356. `deliverNotices`, its seeding rule, and its per-bridge override are unchanged.

### 6.3 Echo suppression, and the write-before-send ordering

The only mechanism is the external-ref table — structural, never heuristic. No text comparison, no time window, no recently-sent cache.

- An entry written by `ingest` carries an `inbound` ref. `deliver` skips any entry that has one.
- **`deliver` writes its `outbound` ref BEFORE calling the platform**, with a null platform message id, and patches the id in after the send returns. A crash between write and send therefore yields a _suppressed retry_ (an entry that looks delivered and is not) rather than a _duplicate_ (a message a person sees twice). That is the correct side to fail on: a missing message is visible in the room and recoverable by the person; a duplicate in someone else's chat is not recallable.
- A row whose platform id is still null after the retry budget is resolved by §10.1's notice, so the suppressed case is never silent.
- `deliver` is idempotent on `entryId`: an existing outbound row is a no-op.

### 6.4 The delivery principal

`deliver` publishes to the chat's `relay.human.*` subject through `RelayCore.publish`, under a **new, non-exempt principal**:

```
relay.bridge.{reply|initiate}.{adapterId}.{chatId}
```

**The classification is part of the principal, and its position is load-bearing.** The gate is handed two strings and nothing else (§6.6), so the only channel through which `deliver`'s classification can reach it is the `from` value itself. `reply|initiate` sits **ahead of** the variable-length tail because a Telegram chat id — and, later, a Slack channel id — may contain a dot: parsing the classification from a fixed position after the `relay.bridge.` prefix cannot be shifted by anything in `adapterId` or `chatId`. Putting it at the end would make the gate's read depend on how many dots the chat id happened to have, which is the class of bug `parseHumanSubject` already had to be written carefully to avoid (`human-subject.ts:55-60`).

`isServerOnlyPrincipal`'s `startsWith('relay.bridge.')` matches both spellings unchanged, so **R2's route guard is unaffected** by this grammar and needs no second branch.

It is deliberately not `agent:*`, not `relay.system.*`, and not a `.bot` echo — those are the three exempt principals (`initiate-consent.ts:157-161`), and a bridge riding any of them would skip the gate entirely. `isConsentExemptPrincipal` is **unchanged**: it still has exactly three branches, and `relay.bridge.*` matches none of them.

**But non-exempt is not the same as unassertable, and that gap must be closed.** `POST /api/relay/messages` takes a client-supplied `from` and rejects it only when `isConsentExemptPrincipal(from)` is true (`apps/server/src/routes/relay.ts:202`). `relay.bridge.*` is deliberately non-exempt, so it would sail straight through — and with `canReply` defaulting to `true` (`relay-adapter-schemas.ts:475`), any local caller could publish arbitrary text into the chat **as the bot**, with no room entry and no external ref. That defeats §9.4's audit-trail guarantee, which is one of the three things this feature promises.

So the route gains a second, wider predicate:

```
isServerOnlyPrincipal(from) = isConsentExemptPrincipal(from) || from.startsWith('relay.bridge.')
```

**`isServerOnlyPrincipal` is used by the HTTP route only** — it is the "a client may not assert this" question, which is a different question from "the consent gate trusts this." `isConsentExemptPrincipal` keeps its three branches and keeps its one meaning, so A11.3 is unaffected. The two predicates living side by side, with the wider one named for what it actually guards, is the point: collapsing them is how this hole opened in the first place.

**Defense in depth: the server-only property also holds at the publish pipeline (DOR-889).** The route predicate above closes the one client-facing ingress that exists today, but it is a per-route guard: a **future** ingress forwarding a caller-supplied `from` without re-implementing it would be a bypass with no second line of defense — the residual risk D-7 amendments 3 and 4 name explicitly. So the property is now also enforced one layer down, at `RelayCore.publish` itself. A `relay.bridge.*` `from` reaching the pipeline is rejected — before the consent gate and every delivery path, dead-lettered as `untrusted_bridge_principal` — **unless** the caller set the `serverBridgePrincipal` trust marker on `PublishOptions`. That marker is an in-process argument, never a wire field, so no client and no forwarded envelope can carry it; it is set by exactly the three legitimate bridge publishers (`deliver`, the task-completion notifier, and the `relay_notify_user` tool). This makes "a `relay.bridge.*` principal is only publishable by trusted server code" hold for **every** ingress by construction, not per-route. The HTTP route guard stays as the outer perimeter (unchanged); the pipeline guard is the inner, structural one. The canonical `relay.bridge.` prefix moves to `@dorkos/relay` so the pipeline and `bridge-principal.ts` read one definition, never two that can drift.

### 6.5 Reply targeting and threading

For a delivered entry whose provenance resolves to an inbound entry (§6.6), `deliver` sets `reply_to_message_id` to that message's platform id and `message_thread_id` to the inbound ref's topic id when present. For an entry answering nothing, neither is set.

### 6.6 Consent: reply vs initiate, and what actually enforces it

**The honest starting point: `canReply` is unenforced today.** `bindingAllowsInitiate` is `enabled && canInitiate` (`initiate-consent.ts:134-136`); replies ride the blanket `agent:*` exemption (`:157`); `canReply` is read only into `__bindingPermissions` alongside `permissionMode`. So this spec cannot claim the existing gate suffices — it must extend it.

**The work splits across two places, and the split is forced by a type.** `InitiateConsentGate` is `(from, subject) => decision` (`packages/relay/src/types.ts:169`) — two strings. It cannot see the entry, its `cascadeRoot`, the external-ref table, or the delivering author, so it cannot classify provenance and cannot run a sender check. Asking it to would mean widening a seam every publish path shares, for one caller.

So:

**In `deliver`** — which holds the entry, the bridge row, and the refs:

1. **Classify provenance** as reply or initiate (rule below).
2. **Check the delivering author** — it must be the binding's agent or the operator. §9.3's "an agent cannot deliver to a chat it is not bound to" rests here, not on `checkSender` (`initiate-consent.ts:260-303`), which never sees a bridge delivery's author.
3. Publish under `relay.bridge.reply.{adapterId}.{chatId}` or `relay.bridge.initiate.{adapterId}.{chatId}` — the classification is carried **in the principal**, because that string plus the subject is everything the gate will see.

**In the gate** — one new non-exempt branch for `relay.bridge.*` principals, which:

1. reads the classification from the principal's fixed third segment (§6.4), denying an unrecognised value rather than defaulting to either;
2. parses `{adapterId, chatId}` from the target subject and resolves the binding, denying `NO_BINDING` if none;
3. enforces `binding.enabled && binding.canReply` for an asserted **reply**, and `bindingAllowsInitiate(binding)` (i.e. `enabled && canInitiate`) for an asserted **initiate**.

**Trusting the caller's asserted classification is safe for exactly one reason: `relay.bridge.*` is server-only.** No client can assert that principal (the `isServerOnlyPrincipal` guard above), so the only code that can reach this branch is `deliver` itself. Remove that route guard and this becomes a hole — which is why R2 is specified as a prerequisite and why A6.10 pins it. The gate is still the enforcement point for the two switches; `deliver` is the classifier and the sender check.

**Provenance classification, room-scoped:**

> An entry is a **reply** if and only if its `cascadeRoot` names an entry **in the same room** that carries an **inbound** external ref for the **same `(adapterId, chatId)`**. Everything else is an **initiate**.

The room scoping is load-bearing. `activeTurnFor` → `deepestClaimOf` (`room-claims.ts:212-224`) picks the deepest live claim for an author **across every room**, so an agent triggered in bridged chat R that also posts into bridged chat S would inherit R's cascade root — and R's root is an inbound platform entry. Without the same-room-same-chat condition, a stranger's mention in R launders an initiate into S straight past `canInitiate: false`.

| Provenance                                                                               | Treated as | Gate                     |
| ---------------------------------------------------------------------------------------- | ---------- | ------------------------ |
| Root is an inbound entry, same room, same `(adapterId, chatId)`                          | reply      | `enabled && canReply`    |
| Anything else — cockpit post, scheduled task, agent speaking unprompted, cross-room root | initiate   | `enabled && canInitiate` |

**A blocked delivery is visible.** The room gets a `bridge_blocked` notice, written through `room-notice-log.ts` (the single writer) and damped per `(room, reason)`. A post that silently fails to reach the chat is exactly the invisible failure `.claude/rules/room-conduct.md` forbids. The copy names the switch and where it lives.

**One misclassification is expected and gets its own words.** Turn claims are memory-only and self-heal (`room-trigger.ts` presence republish). A late answer posted after a restart has no live claim, so `post` self-roots it (the `deriveCascade` call at `room-service.ts:729`) and it classifies as an **initiate** — fail-closed silence on a chat with `canInitiate: false`. That is the right failure direction and the wrong user experience to leave unexplained, so `bridge_blocked` carries dedicated copy for it:

> "This answer lost its provenance — the server restarted mid-turn — and was treated as a new conversation. It stayed here."

### 6.7 Author prefixing

Any delivered post whose author is **not the bound agent** — in practice the operator posting from the cockpit — is prefixed with that author's display name at **delivery time only** (D-6 Q4). The prefix is never written into the entry body: the room log holds exactly what the person typed, and a stored prefix would be re-prefixed on every re-delivery and would corrupt the record.

The reason is that the bot is the only identity Telegram gives us, so without the prefix a person in the group cannot tell the operator speaking from the agent speaking.

### 6.8 Presence

The bridge is the missing publisher `outbound.ts:527-529` describes. `publishPresence` (`room-trigger.ts:214`) emits a **`progress`** signal, deliberately not `typing` (agents work, they do not type — `specs/room-presence` §1). The Telegram adapter's signal handler currently branches only on `typing` (`telegram-adapter.ts:341`), so it gains a `'progress'` branch routing to the same `handleTypingSignal`. No new signal type, no second indicator, and the honesty property — the indicator exists exactly as long as the turn claim — is unchanged.

**Acceptance criteria (§6)**

- **A6.1** An inbound message never round-trips back to the platform.
- **A6.2** A `deliver` retry for an already-delivered entry sends nothing; a crash between ref-write and send yields no duplicate on retry.
- **A6.3** A cockpit-authored post reaches the chat when `canInitiate` is on and does not when off; the off case writes `bridge_blocked`.
- **A6.4** An agent's answer to a platform message reaches the chat with `canInitiate` off and `canReply` on, and **does not** with `canReply` off — the test that would have passed vacuously before this spec. The two classifications publish under **distinguishable principals**: a companion test reads the `from` string off the publish and asserts `relay.bridge.reply.…` for the answer and `relay.bridge.initiate.…` for a cockpit post, with a chat id containing a dot, so a positional parse error cannot hide behind a passing gate decision.
- **A6.5** A bridge delivery whose author is not the binding's agent or the operator is refused **inside `deliver`**, before any publish — asserted by observing no publish, not by observing a gate decision.
- **A6.10** A client-asserted `relay.bridge.*` principal on `POST /api/relay/messages` is rejected **403** by `isServerOnlyPrincipal`, and the three previously reserved principals are still rejected by the same route.
- **A6.6** A room notice does not reach the chat from a bridged `channel` by default; `turn_failed` does from a bridged `dm` by default.
- **A6.7** A delivered answer to a forum-topic message carries that topic's `message_thread_id`.
- **A6.8** A turn claim in a bridged room produces a Telegram typing action via the `progress` branch, and releasing the claim clears it.
- **A6.9** An operator-authored delivered post carries the display-name prefix on the wire and **not** in the stored entry body.

---

## 7. History semantics and the migration off `sessionMap`

### 7.1 The room log is authoritative

For a bridged chat the room log is the single shared history. Every triggered turn reads it through `room_context`; every session posting into the room reads it too. The per-`(room, agent)` session keeps its own runtime transcript as private working memory; where they disagree, the room log is the record, and nothing in this spec reads a runtime transcript except the probe in §7.3.

### 7.2 `BindingRouter.sessionMap`

For a binding with `bridge: 'room'`, `sessionMap` is not consulted and not written. `sessionStrategy` becomes meaningless for that binding and the UI hides it with a line explaining that a bridged chat keeps its history in the channel. The field is **not** removed — unbridged bindings still use it and the wire format does not change (§11).

### 7.3 Migration: adoption, gated on a real transcript

Bridging a binding that already has a live session **may adopt** it as the room's `(room, agent)` session. Adoption is attractive — a person who bridges a week-old chat should not have their agent forget the week — but it is not safe unconditionally, because **`BindingRouter` is not an `onProjectorRekey` listener** (`apps/server/src/index.ts:1289` registers only the connector service), so a session id in `sessions.json` can name a session that was rekeyed out from under it.

The rule:

1. Find **the single `{bindingId}:chat:{chatId}` entry**, whatever the `sessionStrategy` — the key is what identifies the conversation, not the strategy label. More than one candidate, or none: start fresh.
2. **Probe that the session has a real transcript**, plus a matching runtime type. **Use the existing reader — do not write a second one:** `TranscriptReader.hasTranscript(vaultRoot, sessionId) → { exists, root? }` (`services/runtimes/claude-code/sessions/transcript-reader.ts:207-213`), which searches across accounts and returns the owning account root when it finds one. That is the **durable** signal — the JSONL file on disk, the fact `hasStarted` names (`agent-types.ts:49`: "True once the first SDK query has been sent (JSONL file exists)"). It must **not** read the in-process session map (`sessions/session-store.ts:221`), which is empty after a restart and would make adoption fail for every bridge created shortly after the app launches — precisely when a person is most likely to be setting one up. A stale or never-started id fails the probe.
3. Probe passes → write it into the room-session ledger for `(room, boundAgent)`, remove it from `sessionMap`, persist, and post a notice: the conversation continues here, and the earlier messages live in that session.
4. Probe fails → start fresh, and post the same notice minus the pointer.

**The room log does not gain the old messages.** Telegram gives bots no history read, and the session transcript is runtime-owned (ADR-0310); copying it into the room would be DorkOS asserting a record it did not witness. The notice says exactly this, in plain words.

### 7.4 Unbridging

Unbridging does not return the session to `sessionMap`. The room keeps it; a re-bridged chat re-adopts it from the ledger. A chat that goes back to private-pipe mode starts a new session, and the archived room's notice says where the old one went.

### 7.5 Proactive notifications must not die with `sessionMap`

`resolveNotifyTarget`'s `pickMostRecentChat` walks `bindingRouter.getSessionsByBinding(...)` (`services/relay/notify-target.ts:98-115`) to find the most recently active chat. Bridged bindings vacate `sessionMap` (§7.2), so **task-completion notices and `relay_notify_user` would silently stop reaching a bridged chat** — a regression invisible until someone notices their agent stopped telling them things.

So: **a live bridge counts as an active chat.** `pickMostRecentChat` also considers bridge rows, each contributing `{ binding, chatId, at: bridge.lastActivityAt }`, where `lastActivityAt` is stamped by `ingest` and by successful delivery. Recency competes on one axis across both sources; ties resolve to the existing behaviour. The resulting proactive send still goes through the consent gate as an **initiate** (§6.6), so `canInitiate` remains the switch it always was.

**Acceptance criteria (§7)**

- **A7.1** After bridging a binding with a live, started session, **the first turn in the bridged room resumes that conversation** — asserted on the runtime's resumed conversation (the transcript the turn receives), not on the ledger row.
- **A7.2** Bridging a binding whose `sessionMap` id fails the transcript probe starts fresh and posts the pointer-less notice.
- **A7.3** A bridged binding's inbound message causes no read or write of `sessionMap`.
- **A7.4** A turn in a bridged room receives `room_context` containing the prior room entries.
- **A7.5** With every session vacated from `sessionMap`, `resolveNotifyTarget` still resolves the bridged chat, and its send is gated as an initiate.

---

## 8. Privacy-mode honesty

Telegram's privacy mode is ON by default for group-added bots: the bot receives only commands, `@mentions`, and replies to its own messages. Turning it off requires removing and re-adding the bot to every group — a deliberate friction that makes the escalation visible. D-3 keeps it default-ON and requires the channel to say what it can see.

**The source of truth is the platform.** `getMe` returns `can_read_all_group_messages`; the adapter exposes it (§11.2) and the bridge records `visibility: 'mentions-only' | 'everything'` with `visibilityCheckedAt` on the bridge row.

- **The channel header** carries a badge: **"sees mentions only"** or **"sees everything"**. Tapping it explains that this is Telegram's own switch and that changing it means removing and re-adding the bot. It is not a setting.
- **`room_context`** carries `visibility: 'partial' | 'full'` with the reason, so a model knows its view is partial. An agent that believes it saw a whole conversation it saw a tenth of will confidently describe a group it cannot read.
- **A DM has no badge.** Privacy mode is a group concept; a badge there would imply a limit that does not exist.

**The honest gaps, stated:**

1. `can_read_all_group_messages` is **bot-wide**, not per-group. A bot with privacy off that was added to a group before the flag changed may still be restricted there. The badge describes the bot's setting, and its copy says "in groups where it was added after this was set." Inferring per-group visibility from observed traffic would be a guess presented as a fact.
2. The badge describes Telegram's gate only. The adapter's own `respondMode` (§5.4) is a **second** gate, and a bot with privacy off but `respondMode: 'thread-aware'` still sees only addressed messages. The badge's expanded copy names both, because a person reading "sees everything" next to a log of only mentions would rightly conclude the product is lying.

**Acceptance criteria (§8)**

- **A8.1** A bridged group room's header shows a visibility badge sourced from `getMe`, not from config.
- **A8.2** A bridged DM room shows no badge.
- **A8.3** The badge's explanation names Telegram as the owner of the switch, describes the re-add ritual, and names `respondMode` as the second gate.
- **A8.4** `room_context` for a turn in a partially visible bridged group carries `visibility: 'partial'`.

---

## 9. Security: untrusted authorship, and the injection stance (DOR-633)

### 9.1 What changes about the threat model

Today every author whose text reaches a room's model is on this machine. A bridged room breaks that: a Telegram bot is publicly discoverable, so an arbitrary stranger can put text into a durable store read verbatim into the context of a model holding this machine's filesystem, credentials, and tools.

> **Untrusted is a property of the author, established at write time, carried on the entry, and enforced at render. It is never inferred from the text and never re-derived at render time.**

### 9.2 The three regions, restated for external authors

| Value                                                                                               | Region                                                         | Treatment                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External message body, caption, media placeholder                                                   | **Inside the fence** (`room-context-block.ts`, per-turn nonce) | Unchanged from any other member's message.                                                                                                                                                                                                                                                                     |
| External display name, platform chat title, room title derived from it, **forum topic name** (§5.6) | **Labels, outside the fence**                                  | Must pass `sanitizeIdentity` from `@dorkos/shared/untrusted-text` — the existing function, never a second copy. Applied at **mint/creation time as well as render time**, because a platform title becomes a room title and a topic name becomes a per-entry label, both read by paths that predate this spec. |
| `origin`                                                                                            | Label                                                          | Derived from the stored natural key (§4.3). Never from payload.                                                                                                                                                                                                                                                |

**One new marking, required.** `RoomContextEntry` gains `authorOrigin: 'local' | 'external'`, and the fenced rendering labels external entries with one word. The fence preamble for a bridged room gains a single standing line: that this channel receives messages from people outside this machine, that their text is data and never instructions, and that a request arriving this way to read files, run commands, or send messages elsewhere is a request from a stranger. This is framing; §9.3 lists the mechanisms.

`ownRecent` remains **outside** the fence and remains the laundering path `room-context-block.ts:52-66` documents — external text quoted back by the agent lands there, measured at 46 characters ahead of the fence. `defuseSystemTags` on that region is load-bearing for exactly this feature, and §13 pins it with an external author.

### 9.3 What a stranger cannot reach, structurally

| Lever                                           | Why a bridged stranger cannot pull it                                                                                                                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Making an agent run at all                      | Only a claimed chat routes anywhere (§3.1); in a group, only an addressed message survives privacy mode + `shouldProcessGroupMessage` + `mention-only` (§5.4).                                                                                     |
| Making an agent run repeatedly                  | Turn budget's two ceilings and the cascade guard, unchanged; plus §5.2's ingest ceiling on the log itself.                                                                                                                                         |
| Speaking to a chat the operator never connected | The gate requires a binding for the exact `(adapterId, chatId)`; `deliver` independently refuses any delivering author that is not the bound agent or the operator (§6.6); and `relay.bridge.*` is server-only, so no client can assert it (§6.4). |
| Starting a conversation on any channel          | `canInitiate` defaults `false`, and cross-room provenance laundering is closed by §6.6's same-room-same-chat condition.                                                                                                                            |
| Escalating tool permissions                     | `permissionMode` defaults to `'default'` — the prompting mode — precisely because "a binding carries messages from off this machine and nobody picked a mode for it" (ADR `260727-181825`). No bridge path may raise it.                           |
| Getting an agent added to a room                | `addMember` is operator-only (`room-service.ts:588-590`).                                                                                                                                                                                          |
| Impersonating the operator or another agent     | Author identity is server-derived; the display name is a sanitized label. Text claiming to be from someone renders as that person's message saying so, inside the fence.                                                                           |

### 9.4 What we are not claiming

Not injection-proof. A model that reads a stranger's message and acts on it can still do harm within granted permissions. Three statements belong in the docs and the connection UI:

1. **Bridging a chat lets people you may not know put text in front of your agent.** Said once, plainly, at the moment of bridging.
2. **The permission mode is the real bound.** A bridged binding prompts by default; raising it is a decision with a stranger on the other end.
3. **The room log is the audit trail.** Every message that reached a model is in it, durable and never trimmed — a genuine advantage over the private-pipe shape, where the same message reached a model and left no DorkOS-owned record.

### 9.5 Secrets

Nothing about the bot token, adapter config, or agent credentials enters a room entry or a room context.

**Acceptance criteria (§9)**

- **A9.1** A message containing a forged fence-closing marker, a `<room_context>` tag, or a newline-plus-marker renders inside the fence with the nonce intact — asserted on `formatRoomContext`'s output, which all three runtimes call.
- **A9.2** A display name containing `<`, `>`, or control characters (including NEL) renders in the preamble with none present; the preamble contains no `<` or `>` at all.
- **A9.3** A platform chat title and a forum topic name containing markup are sanitized **in the store**, not only at render.
- **A9.4** `room_context` marks an external entry `authorOrigin: 'external'` and carries the bridged-room standing line.
- **A9.5** External text quoted back by the agent renders in `ownRecent` with tags defused.
- **A9.6** A bridge-created binding has `permissionMode: 'default'`; no bridge path writes a more permissive mode.
- **A9.7** An agent cannot deliver to a chat it is not bound to by posting into a room bridged to another agent — asserted through `deliver`'s author check (A6.5) and, independently, through the route guard (A6.10).

---

## 10. Failure modes

| #     | Failure                                       | Behaviour                                                                                                                                                                                                                                                                                                                                         |
| ----- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10.1  | **Platform down / adapter disconnected**      | Inbound does not arrive. Outbound sends fail with the ref already written (§6.3); retry with bounded backoff (3 attempts, exponential, ≤ 2 min). On final failure the room gets a damped `bridge_undelivered` notice naming the entry, and the ref's null platform id makes the entry eligible for §6.1's catch-up scan when the adapter returns. |
| 10.2  | **Rate limit (429 + `retry_after`)**          | Honour `retry_after` exactly; deliveries for that chat queue behind it in `seq` order. Sustained limiting past the retry budget degrades to 10.1.                                                                                                                                                                                                 |
| 10.3  | **Bot blocked / kicked / chat deleted (403)** | Terminal, not retried. Archive the room per §3.5, set `bridge: 'off'`, notice names the platform's own reason.                                                                                                                                                                                                                                    |
| 10.4  | **Late replies**                              | Reused unchanged: late delivery posts the answer into the room with how long it took (`room-trigger.ts:983+`); the bridge delivers that post like any other. §6.6's restart caveat is the one case where a late answer stays in the room, and it says so.                                                                                         |
| 10.5  | **A turn that never answers**                 | Existing notices fire in the room unchanged; they reach the chat only per §6.2.                                                                                                                                                                                                                                                                   |
| 10.6  | **Platform edit / delete**                    | Ignored in phase 1; a committed entry is not mutated. Phase 3 may append an `[edited]` follow-up — never an in-place rewrite.                                                                                                                                                                                                                     |
| 10.7  | **Duplicate delivery from the platform**      | §5.2 step 1.                                                                                                                                                                                                                                                                                                                                      |
| 10.8  | **Server restart mid-turn**                   | Turn claims are memory-only and self-heal. The inbound entry is durable; a late answer landing after the restart is subject to §6.6's misclassification and its dedicated notice.                                                                                                                                                                 |
| 10.9  | **Room archived out-of-band while bridged**   | `RoomService.post` throws `ROOM_ARCHIVED` (`room-service.ts:696`); `ingest` catches it, sets `bridge: 'off'`, and tells the chat once through `chatNotice`.                                                                                                                                                                                       |
| 10.10 | **Two bridges pointed at one room**           | Refused at write: unique indexes on `roomId` and on `(adapterId, chatId)`.                                                                                                                                                                                                                                                                        |

**Acceptance criteria (§10)**

- **A10.1** A delivery failure leaves the room entry intact and produces exactly one `bridge_undelivered` notice after the retry budget.
- **A10.2** A 429 with `retry_after` delays the next delivery for that chat by at least that long and preserves `seq` order.
- **A10.3** A 403 blocked-by-user archives the room, sets `bridge: 'off'`, and writes a notice naming the reason.
- **A10.4** A late answer reaches the chat with its "took N minutes" note.
- **A10.5** Posting into an archived bridged room turns the bridge off exactly once and notifies the chat once.
- **A10.6** A second bridge for an occupied `roomId` or `(adapterId, chatId)` is rejected.
- **A10.7** An entry committed while the adapter is down is delivered after reconnect, **exactly once** — driven by the catch-up scan, with a subscriber drop simulated so the live stream cannot be what carried it. A sibling case asserts the same for a `deliverNotices`-eligible `turn_failed`, which a `kind: 'post'`-scoped scan would have stranded.

---

## 11. What does not change, and what is additive

### 11.1 Unchanged

- **The subject grammar** `relay.human.{platform}.{instanceId}[.group].{chatId}`, `RelayEnvelope`'s shape, `ChannelTypeSchema`, `SignalTypeSchema`.
- **The adapter contract.** No new publish shape and no change to any existing adapter method's signature. The adapter's additive gains — a `getMe` accessor and a `'progress'` branch on its signal handler — are enumerated in §11.2 and §6.8; this bullet defers to them rather than claiming a stillness it does not have.
- **The `AgentRuntime` seam.** No runtime knows a room is bridged; framing stays structured context (ADR-0273) through the one shared builder.
- **Turn selection.** `addressing.ts`, `cascade-guard.ts`, `turn-budget.ts`, and the claim map are untouched; no new caller triggers a turn.
- **The consent exempt set.** `isConsentExemptPrincipal` keeps exactly its three branches. The gate gains **exactly one non-exempt branch** for `relay.bridge.*` (§6.4, §6.6) — an extension of enforcement, not a widening of exemption.
- **Session ownership.** Runtime-owned (ADR-0310); the room log does not become a transcript.
- **Unbridged bindings.** `bridge: 'off'` behaves byte-identically to today, including its `sessionMap` entry.

### 11.2 Additive, and named

The Telegram adapter gains four things. All are additive payload fields or accessors; none changes the publish shape or the subject grammar.

1. `platformData.replyToMessageId` — the id of the message being replied to, for §5.4's reply-as-addressing and §6.5.
2. `platformData.messageThreadId` **and** `platformData.threadName` — forum topic id and name (§5.6, §9.2).
3. `platformData.media` — a descriptor `{ type, durationSec?, fileName?, mimeType? }` for §5.5, **and** the lifting of the captionless-media drop at `inbound.ts:427-430` so those messages publish at all.
4. A `getMe` accessor exposing `can_read_all_group_messages` for §8.

Server-side additions: `isServerOnlyPrincipal` beside `isConsentExemptPrincipal` in `services/relay/initiate-consent.ts`, used by `routes/relay.ts:202` only (§6.4).

Publish-pipeline addition (DOR-889, defense in depth): a `serverBridgePrincipal` marker on `PublishOptions` and, in `RelayPublishPipeline.publish`, a guard that rejects any `relay.bridge.*` `from` published without it (dead-lettered as `untrusted_bridge_principal`, ahead of the consent gate). This is additive — no existing publisher's behavior changes, because the three legitimate bridge publishers set the marker and every non-bridge `from` is untouched. It moves the server-only assertion from a per-route guard to a by-construction property of the pipeline that covers every ingress, with the route guard kept as the outer perimeter (§6.4). The canonical `relay.bridge.` prefix (`BRIDGE_PRINCIPAL_PREFIX`) moves to `@dorkos/relay`, which `services/relay/bridge-principal.ts` re-exports, so there is one definition read from both sides of the publish seam.

Schema-side additions: `bridge` and `roomId` on `AdapterBindingSchema` **and** `UpdateBindingRequestSchema`; `origin` on roster and room-context member types; `authorOrigin` and `visibility` on room context; three new codes on `RoomNoticeCodeSchema` (`bridge_blocked`, `bridge_undelivered`, `bridge_rate_limited`).

**One of these is not additive for old clients, and the spec says so rather than claiming a clean bill:** widening `RoomNoticeCodeSchema` means a client pinned to the old enum fails to parse a room containing a bridge notice. That is a same-repo client shipped in lockstep, so it is acceptable — but it must be stated in the changelog fragment, and it is why A11.1 is scoped the way it is.

**Acceptance criteria (§11)**

- **A11.1** The OpenAPI diff contains only additive fields **except** the `RoomNoticeCodeSchema` enum widening, which is enumerated explicitly in the diff review and in the changelog fragment.
- **A11.2** An existing bindings file with no `bridge` field parses, defaults to `'off'`, and routes exactly as before — pinned by a fixture predating this change.
- **A11.3** The exempt set is unchanged — `isConsentExemptPrincipal` has the same three branches after this change as before — and the gate has exactly one new non-exempt branch.

---

## 12. Rollout

**No global feature flag.** `binding.bridge` defaults `'off'`, so the feature is inert until a person turns it on for one chat — no config migration, and the blast radius of a bug is one chat.

- **Phase 1 — Telegram, the bridge itself.** Bridge store and schema fields; the `createBridgedRoom` path and the `findDmByMemberSet` exclusion (§3.2); `ingest` and `deliver`; external identity and origin; echo suppression with write-before-send; the gate's non-exempt branch and room-scoped provenance; the three notice codes; adoption with the transcript probe; notify-target bridging; presence forwarding; the four adapter additions. Cockpit: bridge action, origin marks, visibility badge.
- **Phase 2 — the claim card path.** Move 2's card gains "Answer in a channel" as its primary action, creating claim + binding + bridge + room atomically. Group-add claim flow.
- **Phase 3 — Slack and the deferred edges.** Slack bridging (threads → DorkOS threads, which is why D-6 Q1 defers to it); topic-per-room if that resolves so; `[edited]` follow-ups; media payloads.

**Demo-claim gate.** Until a bridged Telegram chat has been driven end to end by a real person on a real bot, no user-facing copy says this works (`meta/positioning-202607/09-gtm-plan.md` §2.0).

**Acceptance criteria (§12)**

- **A12.1** With no bridge enabled anywhere, the full existing relay test suite passes unchanged.
- **A12.2** Enabling a bridge requires exactly one cockpit action and no restart.

---

## 13. Testing strategy

**Unit**

- Bridge keying; external natural-key derivation including the same user under two instances; the no-local-`platform:`-prefix invariant.
- Dedup: same `messageId` twice; different id, same text.
- Echo suppression, including the crash-between-ref-and-send ordering.
- Kind mapping, slug collision, broadcast refusal, wildcard refusal, ingest ceiling, agent-swap rebind (A3.6b).
- `isServerOnlyPrincipal`: accepts the three exempt principals plus `relay.bridge.*`, rejects `relay.human.console` and `relay.agent.*` — and a paired test asserting `isConsentExemptPrincipal` still answers `false` for `relay.bridge.*`, so the two predicates cannot be collapsed by a later edit.
- Sanitization over display names, chat titles, and topic names including NEL, zero-width, and angle-bracket variants.

**The consent table (§6.6)** — the centrepiece, ten cases:

| #      | Provenance                                                                                                             | Binding              | Expect                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| 1      | Inbound root, same room/chat                                                                                           | `canReply: true`     | delivered                                                  |
| 2      | Inbound root, same room/chat                                                                                           | `canReply: false`    | blocked + notice                                           |
| 3      | Cockpit post                                                                                                           | `canInitiate: true`  | delivered                                                  |
| 4      | Cockpit post                                                                                                           | `canInitiate: false` | blocked + notice                                           |
| 5      | Scheduled task                                                                                                         | `canInitiate: true`  | delivered                                                  |
| 6      | Scheduled task                                                                                                         | `canInitiate: false` | blocked + notice                                           |
| 7      | Inbound root, binding paused (`enabled: false`)                                                                        | any                  | blocked                                                    |
| 8      | Delivering author is not the bound agent or operator (refused in `deliver`, no publish)                                | any                  | refused before publish                                     |
| **9**  | **Cross-room leak:** agent triggered in bridged chat R posts into bridged chat S; S's binding has `canInitiate: false` | —                    | **blocked.** R's root must not launder an initiate into S. |
| **10** | **Post-restart:** late answer with no live claim, self-rooted; chat has `canInitiate: false`                           | —                    | **blocked, with the dedicated restart copy** (§6.6).       |

**Integration (server)**

- Full inbound→room→turn→outbound with `FakeAgentRuntime` and a fake Telegram transport.
- The `BindingRouter` bypass (spy on `AgentSessionCreator`).
- Mention gating in a bridged group, and the ambient tier **with its precondition set explicitly** (privacy off + `respondMode: 'always'`), plus the default-posture sibling asserting the adapter drops it (A2.3).
- Adoption: a `sessions.json` fixture, probe pass and probe fail, asserting **resumed transcript** on the first turn (A7.1).
- `resolveNotifyTarget` with an empty `sessionMap` and a live bridge (A7.5).
- Catch-up delivery with a dropped subscriber (A10.7).
- Archived-room, missing-room, and rate-limit-ordering paths.
- Late reply past the wait.
- **Formatting (§15):** a room post containing a markdown table is delivered to Telegram without breaking, pinning both halves of that section.

**Security (its own file, because §9 is the section most likely to rot)**

- Fence integrity with a hostile external body, over `formatRoomContext`.
- Preamble free of `<`/`>` for a hostile display name, chat title, and topic name.
- `ownRecent` laundering with tags defused.
- `permissionMode: 'default'` on every bridge-created binding.

**E2E (`apps/e2e`)** — one flow: bridge an existing binding, see the channel with its origin marks and visibility badge, post from the cockpit, see the delivery state. The platform is faked at the adapter boundary. Browser tests run un-path-filtered on every PR, so this PR carries its POM updates.

**Mocking stance** — the Telegram transport is faked at the grammY `Bot` boundary, the seam existing adapter tests use. Nothing mocks `RoomService`, `RoomTriggerDispatcher`, or the consent gate; a mock of those would encode the hypothesis instead of testing it (`.claude/rules/testing.md`).

**Acceptance criteria (§13)**

- **A13.1** Every acceptance criterion **A2.1 through A12.2** above has a named test.
- **A13.2** No test in this suite passes when the mechanism it names is deleted — verified by deleting each once during EXECUTE.

---

## 14. Performance

- **Inbound** adds one dedup lookup, one rate-window check, one author resolve (indexed upsert already on the room write path), one entry insert, one ref insert — all synchronous inside one transaction, and strictly less work than the session-dispatch path it replaces for bridged bindings. In the default group posture the volume is bounded by what the bot is addressed with, not by the group's traffic (§5.4), so the busiest realistic case is a bridged DM.
- **Outbound** adds one indexed lookup per committed entry in a bridged room. Unbridged rooms pay one indexed miss; if that shows up, the room row carries a `bridged` boolean and the lookup is skipped. The catch-up scan is bounded by `lastDeliveredSeq` and runs on start, reconnect, and failure resolution — not per entry.
- **Serialization** is per `(adapterId, chatId)` and covers a few indexed writes, never turns.
- **Context size** stays bounded by `PENDING_MAX_ENTRIES` (30) and `OWN_RECENT_MAX_ENTRIES` (5).
- **Storage** grows by one entry plus one small ref row per received message. The log is never trimmed by design; the ingest ceiling (§5.2) is the bound, and it refuses rather than trims.

---

## 15. Message formatting across the boundary

A room post is written for a cockpit that renders full markdown; Telegram is not that. Two halves, and both are needed:

1. **The bridge writes the platform's formatting rules and its `maxLength` into `room_context`** for turns in a bridged room. This reaches all three runtimes through `formatRoomContext` (`room-context-block.ts:522`), so an agent answering in a bridged channel knows what the far end renders — the same information the adapter already puts on the inbound payload as `responseContext.formattingInstructions` (`inbound.ts:460-465`), now available to a turn triggered by a room rather than by an envelope. It is guidance, it lives in the labels region, and it is not load-bearing.
2. **The outbound adapter remains the enforcement backstop**, unchanged: it is what has to survive a model that ignores the guidance, and it already owns splitting and escaping.

Guidance without a backstop is a prompt pretending to be a mechanism; a backstop without guidance produces mangled tables that were avoidable. §13 pins the markdown-table case.

---

## 16. Open questions

**All five are closed.** The founder-gate answers and their rationale are recorded in [`design-decisions.md`](./design-decisions.md) §D-6 and implemented above: Q1 fold topics but record and render the topic name (§5.6); Q2 kind `dm` contingent on §3.2's bridge-row identity, fallback `channel` (§3.3); Q3 multi-agent refused in phase 1 for a named reason (§3.4); Q4 display-name prefix at delivery only (§6.7); Q5 `deliverNotices` keyed on room kind (§6.2).

Nothing else in this spec is unresolved. Two things are deliberately deferred rather than open: the topic split (phase 3, decided with Slack in hand) and media payloads (phase 3).

---

## 17. ADR candidates

Not written here (this stage's output is scoped to `specs/chats-as-channels/`):

1. **A bound chat projects into a room; the room log is the shared history.** Extends ADR `260726-170125`.
2. **The bridge writes entries and never triggers a turn.**
3. **A bridged room's identity is its bridge row, never its member set** — and `findDmByMemberSet` excludes bridged rooms. The correction that keeps a stranger out of the operator's private DM.
4. **Outbound delivery asserts a server-only, non-exempt `relay.bridge.*` principal; the consent gate gains one branch that finally enforces `canReply`; and provenance classification plus the delivering-author check live in `deliver`, not in the two-string gate.** With provenance scoped to the same room and the same chat. The companion decision — `isServerOnlyPrincipal` as a second, wider predicate used by the HTTP route only, leaving `isConsentExemptPrincipal` untouched — belongs in the same ADR.
5. **External authorship is a first-class author property (`origin`) derived from the stored natural key**, marked in room context and enforced at the existing fence. The DOR-633 stance.
6. **Echo suppression is a durable external-ref table written before the send**, never a heuristic.
7. **Bridging adopts an existing session only behind a transcript probe, and never imports platform history.**

## 18. References

- [`plans/language-ia-simplification.md`](../../plans/language-ia-simplification.md) — Phase 3 design decisions, items 3, 4, 5, 8.
- [`research/20260803_connection-scoping-prior-art.md`](../../research/20260803_connection-scoping-prior-art.md) — Telegram mechanics, OpenClaw binding ladder, "the chat IS the thread", Claude Code Channels pairing, the industry gap this closes.
- [`research/20260727_hermes-openclaw-group-chat.md`](../../research/20260727_hermes-openclaw-group-chat.md), [`research/20260724_multi-user-communities.md`](../../research/20260724_multi-user-communities.md), [`research/20260727_agents-in-group-chat-industry-survey.md`](../../research/20260727_agents-in-group-chat-industry-survey.md).
- ADRs [`260726-170125`](../../decisions/260726-170125-a-room-is-a-membership-scoped-durable-stream.md), [`260726-170126`](../../decisions/260726-170126-author-identity-is-keyed-on-the-agents-directory.md), [`260726-170127`](../../decisions/260726-170127-the-room-path-carries-its-own-cascade-guard.md), [`260728-022013`](../../decisions/260728-022013-a-thread-is-a-relation-between-entries.md), [`260731-211050`](../../decisions/260731-211050-a-room-driven-claude-code-turn-leaves-a-record.md); ADR-0273, ADR-0310, ADR-0255, ADR `260727-181825`.
- [`.claude/rules/room-conduct.md`](../../.claude/rules/room-conduct.md), [`meta/agent-etiquette.md`](../../meta/agent-etiquette.md).
- [`specs/room-participation/02-specification.md`](../room-participation/02-specification.md), [`specs/room-presence/02-specification.md`](../room-presence/02-specification.md).
