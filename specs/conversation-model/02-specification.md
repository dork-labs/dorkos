---
slug: conversation-model
id: 261017-211900
created: 2026-10-17
status: draft
---

# One conversation model: the log is shared, the session is private

**Status:** Draft for the designer's review. Docs only; no code lands from this document.
**Author:** Claude (the DorkOS agent), for Dorian Collier
**Date:** 2026-10-17
**Decision:** ADR [261017-211859](../../decisions/261017-211859-a-conversation-is-the-shared-log-a-session-is-private.md)
**Revised:** 2026-10-18, to the navigation fix's plan of record: the DM looks like a room and runs on the session (§3.1, §7 step 4, §8).
**Anchor:** `main` @ `5078d6c7cb`. Every `file:line` below was read on that commit.

## Overview

**A conversation is the shared log. A session is one agent's private working context, seated behind a conversation.**

Rooms already work this way. `room_entries` is the log; `room_members` holds each member's read cursor; `room_sessions` seats one session per agent per room. This spec gives every chat that shape: channels (already there), agent-to-agent DMs, Telegram and Slack, email, threads on objects, and last, 1:1 chats.

Three words, used the same way everywhere below:

| Word             | Means                                                                                        | Today                                            |
| ---------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Conversation** | An id, its members, its log of entries, and threads between entries. Durable, never trimmed. | a room (`rooms`, `room_members`, `room_entries`) |
| **Session**      | One agent's runtime transcript: tools, thinking, todos, subagents, streams. Private.         | a Claude Code JSONL, a Codex thread, …           |
| **Seat**         | One agent in one conversation: which session it works in, and how far it has read.           | `room_sessions` + `room_members.last_read_seq`   |

## 1. Keep, fold, remove

Read against the code on the anchor commit. **Bold** in the "Checked" column marks where the first reading was wrong and is corrected here.

### Kept as "how" (sessions: private, per runtime)

| Store                                    | Where                                                                                     | Landed        | Checked                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code JSONL transcripts            | `~/.claude/projects/{slug}/{id}.jsonl`; ADR-0003                                          | 2026-02-06    | Holds. ADR-0310 already narrowed ADR-0003 to the claude-code runtime: each runtime owns its storage. A room post or chat message is copied in as the turn's fenced prompt; that copy is the session's, not the record.                                                                                                                                   |
| Codex threads, OpenCode store, DOE store | `codex_threads` (`schema/codex.ts:22`); OpenCode sidecar; `runtimes/doe/session-store.ts` | 2026-07 to 10 | **Added.** The other runtimes' transcripts are sessions too, not only Claude Code's.                                                                                                                                                                                                                                                                     |
| OpenCode binding                         | `opencode_sessions` (`schema/opencode.ts:21`)                                             | 2026-07-10    | Holds. An id map only; no words.                                                                                                                                                                                                                                                                                                                         |
| `session_events`                         | `schema/session-events.ts:28`                                                             | 2026-07-10    | Holds, as a **replay cache**. Codex, OpenCode and test-mode keep their event history here; Claude Code writes only turn boundaries, errors and permission answers (`'record'` mode, `session/projector-persistence.ts`, ADR 260731-211050). Trimmed to 5,000 events per session (`session/replay/event-log.ts:27`), so it can never be anybody's record. |

### Kept as helpers (beside the log, never the record)

| Store                                                | Where                                                             | Landed        | Checked                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session_message_queue` (+ `session_staged_context`) | `schema/sessions.ts:88`, `:135`                                   | 2026-08-11    | Holds. Words on their way into a session; a row is deleted when its turn starts. After the move it carries entry ids, not copies of the words (§3).                                                                                                                                                                                              |
| `room_bridges`, `room_bridge_messages`               | `schema/bridges.ts:26`, `:123`                                    | 2026-08-03    | Holds. Maps an entry to a Telegram or Slack message id (and is the only echo guard). Email threads get the same kind of map (§9).                                                                                                                                                                                                                |
| Relay's Maildir and `relay_index`                    | `packages/relay/src/maildir-store.ts`; `schema/relay/index.ts:15` | 2026-02-26    | **Decision changed.** ADR 261006-235240 retires Maildir. Decided here: keep it as the internal delivery bus; it works. `relay_index.payload` does hold words today. Once steps 1 and 2 land, no new words a person reads live only there; the old `relay_send`-era rows are archived as they are, not imported. The ADR amends 261006-235240.    |
| Message search                                       | `messages`, `search_sources` (`schema/search.ts:35`, `:132`)      | 2026-07-29    | Holds. It already indexes `room_entries`. It also indexes four session sources (Claude Code, Codex, OpenCode, DOE); those stay, as session search for whoever may read the session. Each step adds its conversations to the rooms source and removes the special case it replaces. (`search.ts:41`'s comment lists four sources and misses DOE.) |
| `community_room_mirrors`, `community_mirror_entries` | `schema/communities/community-mirrors.ts:21`, `:68`               | 2026-09-17    | **Kept, not folded.** ADR 260916-210002: the remote space's history is the truth. The cached words already live in `room_entries`; these tables only map remote ids to local entries (`:68`) and remote rooms to local rooms (`:21`). The room map becomes the conversation map, keyed by conversation id.                                       |
| `heartbeat_outbox`                                   | `heartbeats/heartbeats.ts:105`                                    | 2026-10-11    | **Added.** Words waiting to be delivered on a beat. An outbox, like the queue; it posts entries once delivered.                                                                                                                                                                                                                                  |
| Notifications, commitments, audit                    | `notifications.ts:26`, `commitments.ts:12`, `audit-events.ts:23`  | 2026-08 to 10 | Holds. Each keeps a title or one line, never a conversation. They link to entries; they do not move.                                                                                                                                                                                                                                             |

### Becomes the log

| Store                                           | Where                          | Landed            | Checked                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `room_entries`                                  | `schema/rooms.ts:636`          | 2026-07-26        | Holds. Primary key `(room_id, seq)`, append-only, never trimmed; threads are `parent_entry_id`/`thread_root_entry_id` in the same log; `session_id` already names the session that wrote an agent's entry. Gains: an origin for outside senders (§4), a turn link (§2.3), and a delivery record beside it (§2.2), never a status column on the entry. |
| `room_entry_reactions`, `room_attachments`      | `schema/rooms.ts:836`, `:906`  | 2026-07-30, 08-08 | Holds.                                                                                                                                                                                                                                                                                                                                                |
| `room_members` (cursor), `room_sessions` (seat) | `schema/rooms.ts:520`, `:1001` | 2026-07-26        | Holds. These are the seat. The person-side `read_cursors` (`schema/read-cursors.ts:59`) stays separate on purpose, as its doc comment says. **Limit:** the cursor is per member, not per session, and `room_entries.dispatch_id` (`rooms.ts:693`) is room-only and off the wire; §2.1 and §2.3 say what changes.                                      |

### Folds in, then goes

| Store                                            | Where                                                                                                                                        | Landed             | Checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat_messages`                                  | `schema/session/chat-messages.ts:18`                                                                                                         | 2026-10-09 (#2694) | Holds. Its words become entries authored by the sending agent, in the receiving chat's conversation. Its statuses (`queued`, `steered`, `working`, `delivered`, `replied`, `failed`; `chat-messages.ts:49-51`) are **not** copied to a column on the entry: they are read from the delivery record (§2.2). `ceiling_json` (the sending turn's power) moves onto the entry's origin; `nonce` is made fresh at each injection, as today. Kinds `start` and `stop` are not entries: a start opens a conversation, a stop is a control event (§2.5). |
| `chat_agent_dms`, `chat_read_cursors`            | `schema/session/chat-messages.ts:85`, `:107`                                                                                                 | 2026-10-09         | **Added.** The agent-to-session DM map (keyed by direction, `(from_agent_path, to_agent_id)`) becomes one two-member DM conversation per agent pair (rooms de-duplicate DMs by the sorted `dm_member_key`, `rooms.ts:490`), so the A-to-B and B-to-A chats merge; §2.1 says how replies still reach the asking chat. `chat_read_cursors` is a **reader's** cursor, per reading session (`:107-119`), not a seat's: it stays, like `read_cursors`, keyed to the conversation instead of a session.                                                |
| `extension_agent_sends`, `extension_agent_chats` | `schema/extensions/extension-agent-sends.ts:43`, `:97`                                                                                       | 2026-10-03         | **Narrower than first read.** It is an idempotency ledger, not a word log: `content` is kept only while a send is held, and finished rows are pruned after 24 hours. The words become entries authored by the extension; the ledger shrinks to idempotency keys; `extension_agent_chats` becomes a conversation lookup like `chat_agent_dms`.                                                                                                                                                                                                    |
| Telegram/Slack in the default mode               | `bridge: 'off'` (`packages/shared/src/relay-adapter-schemas.ts:673`); `binding-router.ts`; `{relayDir}/sessions.json`, `agent-sessions.json` | 2026-02 to 08      | **Added; the biggest gap.** With `bridge: 'off'` (the default), an inbound message is republished to `relay.agent.<runtime>.<sessionId>` and runs a session turn with no room at all. Those chats have no log. Step 1 removes this path for chat-specific bindings. `agent-sessions.json` belongs to the relay Claude Code adapter (`agent-session-store.ts`), and `relay.agent.*` is also used by the A2A gateway (`packages/a2a-gateway/src/dorkos-executor.ts`), so both stay.                                                                |

### Out of scope

| Store                                                    | Why                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `a2a_tasks.history_json` (`schema/a2a.ts:32`)            | A2A is an outside protocol with its own task history. It can post into a conversation later; it is not one. |
| `session_message_acceptance_receipts`, `unclaimed_chats` | No words.                                                                                                   |

## 2. The rules

### 2.1 No double-feed

A session resumes its own transcript. A turn is given only the entries its seat has not read and **that this seat's session did not write**. Its own entries are never fed back to it.

Rooms do this today, and every conversation inherits it as written:

1. At claim time, before any await, the old cursor is kept and the cursor moves to the claimed entry (`rooms/room-trigger/claim-collected.ts:280-283`; `setReadCursor` only moves forward, `room-store.ts:726`).
2. The turn's context is `listUnreadEntries(afterSeq: max(lastReadSeq, joinedSeq), throughSeq: entry.seq, excludeAuthorId: self)`, capped by `rooms.ambient_max_entries` (default 30) (`rooms/room-context.ts:432`, `:466`; `run-turn.ts:67`).
3. A claimed turn that is refused rewinds the cursor with a compare-and-set (`run-turn.ts:358`, `room-store.ts:771`).

Three changes, because the room rule was written for one session per member:

- **Exclude by session, not by author.** `listUnreadEntries` excludes by author today (`room-store.ts:1274`). An agent works from many chats; an entry it wrote from another chat is news to this seat and is fed like anyone else's.
- **A reply reaches the asking chat.** One DM per agent pair means the agent that asked may have asked from a chat that is not its seat. An entry that replies to it (`parent_entry_id`, or `body.answersEntryId`) is also delivered to the chat that wrote the entry it answers, the way `chat_send` replies come back today.
- **A new session gets a recap, not a rewind.** When a seat's session changes (a rebind, a bridge adopting a chat, `room-bridge-lifecycle.ts:147`), the cursor stays where it is and the new session's first turn gets a bounded recap from the log.

The 1:1 case is the same rule with one member: the person's new words are the entries the seat has not read.

**A backfill never feeds.** Entries backfilled from transcripts or from `chat_messages` are already in their sessions. A backfill writes without dispatch and moves each seat's `last_read_seq` and `joined_seq` to the last backfilled seq, the way ADR 260916-210002 already keeps imports from executing old mentions.

### 2.2 Delivered means in the context

**Delivery is proven by a per-turn record, not by the cursor.** The cursor says what is unread; it cannot prove delivery. It moves at claim, before the runtime is asked (`claim-collected.ts:280-283`); a refused turn rewinds it, after which a failed entry looks queued (`run-turn.ts:358`); and it jumps past entries the ambient window (default 30) never showed (`room-context.ts:466-472`).

So each turn writes one **delivery record**: its dispatch id, the entry ids actually shown to the agent, when the runtime accepted the turn, and why it failed if it did. Statuses are read from those records:

| Status      | True when                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`    | No turn has shown the entry to the receiver yet. The sender also sees its place in line and what is ahead.                              |
| `delivered` | A turn **the runtime accepted** showed the entry (accepted means the runtime took the prompt, not DorkOS's own `turn_start`).           |
| `replied`   | A turn that was shown the entry produced a reply, or an entry names it as its parent or as the entry it answers. Never any later entry. |
| `failed`    | The turn that held it was refused before the runtime accepted it. The record says why.                                                  |

This is the rule DOR-2994 broke: today `delivered` is written when a turn's stream merely did not throw, so a turn the runtime refused (the warm-session limit) still marks the message delivered, and `replied` is set by any later send from the receiver, even while the message is still queued. DOR-2994 fixes today's `chat_messages` to these meanings now, so step 2 inherits them.

### 2.3 Every reply links to its turn

An entry an agent writes records its `session_id` (already on `room_entries`) and the turn that produced it. **No runtime-neutral turn id exists today:** `room_entries.dispatch_id` is room-only and kept off the wire (`rooms.ts:693`), and `turn_start` rows in `session_events` are trimmed at 5,000 per session (`session-event-store.ts:210`). So the link stores the dispatch id plus a runtime anchor (the JSONL message uuid, the Codex turn id). A link whose anchor is gone shows "this turn is no longer available". A reader who may see that session opens the turn from the entry (UX R2).

### 2.4 Who wrote it

Every entry has one author row: a person, an agent, an extension, or an outside sender (Telegram, Slack, email). The origin of an outside sender's entry is stamped by the server (ADR 260804-093320, external authorship), and an agent reads it fenced as outsider words. A chat message keeps ADR 261009-171114's stamp: the sending agent and chat, server-written, never typed.

### 2.5 The chat-message rules carry over

ADR 261009-171114 stands. Moving its words into the log must not loosen any of its rules:

- **Power flows downstream.** A turn runs no looser than the tightest ceiling of any chat-message entry in its window. An entry whose ceiling is tighter than the turn about to run waits for a turn of its own; it never rides along at a person's power.
- **The person first.** A person's message still runs ahead of agent-sent ones, and agent entries that wait together still run as one turn.
- **No loop guard, no turn cap.** Agent DMs are exempt from room turn budgets and reply limits until DOR-2745 decides what replaces turn-counting guards. The machine-load launch cap still applies.
- **Steer and interrupt.** `steer` joins a running turn and records the entry in that turn's delivery record without moving the cursor. `interrupt` stops the turn and runs next. `stop` is a control event in the audit trail, not an entry.

## 3. What each chat becomes

| Chat                                        | Today                                                                                     | Becomes                                                                                                                                                                                                                                                                                                | Step    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Channel, thread                             | a room                                                                                    | unchanged                                                                                                                                                                                                                                                                                              | done    |
| Room DM (person and agent)                  | a room, `kind: 'dm'`, with the agent's seat session behind it (the Direct chat, DOR-2997) | **the DM.** Now: the room's look over that seat session, which keeps history, streaming and the step view (navigation fix Phase 1). Step 4: the room becomes the true record underneath, with no visible change. The room row stays                                                                    | now, 4  |
| Telegram/Slack, `bridge: 'room'`            | a projection of a room (ADR 260814-024525)                                                | unchanged                                                                                                                                                                                                                                                                                              | done    |
| Telegram/Slack, `bridge: 'off'` (default)   | `relay.agent.*` republish into a session; no log                                          | a room conversation; the binding's default becomes `'room'`                                                                                                                                                                                                                                            | 1       |
| Agent to agent (`chat_send` to an agent id) | a session of the receiver, found through `chat_agent_dms`; words in `chat_messages`       | a two-member DM conversation; each agent seated with its own session                                                                                                                                                                                                                                   | 2       |
| `chat_send` to a chat id                    | a `chat_messages` row, queued into that session                                           | an entry in that chat's conversation, authored by the sending agent                                                                                                                                                                                                                                    | 4       |
| Spin-off report                             | `chat_messages` row, `kind: 'report'`                                                     | an entry in the parent's conversation with the spin-off                                                                                                                                                                                                                                                | 4       |
| Extension `ctx.agent.send`                  | `extension_agent_sends` + a session                                                       | an entry authored by the extension in a conversation anchored to it                                                                                                                                                                                                                                    | 3       |
| Doc and object comments                     | separate per feature (DOR-2983)                                                           | a conversation anchored to the object                                                                                                                                                                                                                                                                  | 3       |
| Email                                       | none                                                                                      | a bridged conversation (§9)                                                                                                                                                                                                                                                                            | after 1 |
| 1:1 chat                                    | the session itself (ADR-0003, ADR-0310)                                                   | a session behind a seat, never a conversation of its own. A **New topic** in a DM starts one, shown as a card in the DM; at step 4 a topic becomes a thread in the DM with its own seat. Older chats stay readable sessions, listed under Sessions and the agent's profile › Chats. Nothing is deleted | now, 4  |

### 3.1 The DM: looks like a room, runs on the session

The plan of record (navigation fix, 2026-10-18, PM-approved). A person talks in rooms; an agent works in sessions. Every chat with an agent is a DM: one per member set, the same one every time.

- **Now, with no migration.** The DM is today's Direct chat: the person-plus-one-agent `dm` room and the agent's seat session in it (§8.1). It wears the room's look: the room's header, the room-style composer (slash commands kept), replies with their work folded into one line, and a right panel with a Work tab. The session keeps feeding it, so history, token streaming, tools, thinking and todos all stay. The model, account, context and permission controls move to the session view behind Settings › Show sessions.
- **At step 4, the switch nobody sees.** The room becomes the record underneath (§7). Nothing on screen changes.
- **Who answers.** An agent set to mention-only still answers every message in its own DM, with no @ needed.
- **One agent, two seats.** The agent in #design and the agent in your DM are two seats with two sessions, one per (room, agent). A quoted reference ("From #design") is how one learns about the other. It's explicit, so it's never a leak.
- **A session behind a channel seat is not the channel.** A person who types in that session runs a plain session turn (no `roomTurn`), so the reply stays in the session. It reaches the channel only if the agent posts there. The session view says so in one line; a reply never goes missing silently.
- **Agent-to-agent DMs** (step 2, DOR-3048) are filtered out by membership: they never appear in the owner's DM list or unread counts.

## 4. Outside senders

Telegram, Slack and email are windows onto a conversation this computer (or a space) owns. Their entries carry an external origin and an outside-sender author. Agents read them fenced. Replies go out through the bridge's helper table (`room_bridge_messages`, and its email twin). Nothing about this is new for Telegram and Slack in room mode; step 1 makes it the only mode.

## 5. Spaces

A conversation in a remote space is the remote server's truth (ADR 260916-210002). The local rows are a cache: `room_entries` holds the cached words and `community_room_mirrors` maps the remote conversation to the local one. The seat and session stay on the computer where the agent runs. This holds for every conversation kind above once it can live in a space.

## 6. Addresses

**Rule: an address points at exactly one conversation id.** Everything a person or an outside system can type (an email address, a link, a mention in another space) resolves to one conversation, so a reply always lands in the same log.

| Form      | Shape                                     | Example                          | Used for                                 |
| --------- | ----------------------------------------- | -------------------------------- | ---------------------------------------- |
| Canonical | `dork://{space}/{handle}/{conversation}`  | `dork://acme/marketing/c_01J…`   | storage, links, the API; never shown raw |
| Display   | `{handle}[+{name}]@{space}`               | `marketing+launch@acme`          | what people see and type                 |
| Email     | `{handle}[+{name}]@{space}.{mail domain}` | `marketing+launch@acme.<domain>` | inbound and outbound mail (§9)           |

- `{handle}` is a member's handle: a person or an agent.
- `+{name}` picks a named conversation that member owns (a project, a customer, a launch). The name is a stable slug on the conversation, not its id, so it can be renamed only by keeping the old name as an alias.
- A bare `{handle}@{space}` points at that member's **front door**: one conversation per outside sender, made on first contact, so two strangers never share a log.
- `{space}` is the space's slug. On this computer's private space it is the install's own slug.

**What exists today.** `authors.handle` (`packages/db/src/schema/rooms.ts:85`) is lowercase by grammar and unique per install by `authors_handle_unique` (`:178`). A freed handle is kept in `handle_tombstones` (`:213`, unique on `lower(handle)`) so it cannot be taken again and inherit someone's old mentions. Nothing parses or stores `dork://` or `+name` today.

**Open item: per-space handles.** A local handle is unique per install, but a person or agent belongs to several spaces, and two spaces can each have a `marketing`. Space servers already have per-space handles: `community_handles` is one namespace for people and agents per space, never released, and `agents.handle` is unique per space (`specs/server-merge/03-agents-as-members.md`). C4 (DOR-2876) keeps it that way: an agent's member row has **no** handle (its decision 13); the handle stays in `agents.handle` and `community_handles`. So an address resolves `{handle}@{space}` against that space's `community_handles`, and a local conversation's address uses the install's `authors.handle`. What is open is how a private space's handles relate to a team space's when the same agent is in both. Not decided here.

## 7. Sequence

Each step ships on its own, deletes what it replaces, and leaves every chat readable. 1:1s go last because they are the most-used surface and the only one with live detail to protect. Every backfill follows §2.1's rule: it writes without dispatch and moves the seats past it.

| Step | What moves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Retires                                                                                                                                                          | Lines up with                                                                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Telegram and Slack become room conversations, for bindings to a specific chat.** Flip the binding's `bridge` field default from `'off'` to `'room'` (`packages/shared/src/relay-adapter-schemas.ts:673`), move every existing `'off'` binding with a `chatId` and the per-chat strategy into its own room, and backfill each room from the binding's session transcript where it is readable. Wildcard bindings (no `chatId`, refused room mode by design, `:554-560`, `:685`), group chats of unknown type (`:627-631`), and the `per-user` and `stateless` strategies (`:549`) need a decision first (§10). So does "Answer privately" in the claim flow (`:824-831`), a product choice for the designer and Dorian.                                                                                                                                                                                                                                                                                                                            | the binding router's republish to `relay.agent.*` for those bindings, and `sessions.json`                                                                        | ADR 260814-024525 sanctions the bridge's write path; retiring the private mode is this spec's decision                                                                             |
| 2    | **Agent DMs become two-member conversations.** `chat_send` to an agent id posts an entry into the DM between the two agents; each agent is seated with its own session; replies reach the asking chat (§2.1). Delivery and reply status are read from delivery records (§2.2). `chat_send` to a chat id and spin-off reports stay on `chat_messages` until step 4, because their receiver is a 1:1 chat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `chat_agent_dms`; `chat_messages` rows between agent DMs (backfilled as entries)                                                                                 | **server-merge step 2 / C4, "every message has one author" (DOR-2876)**: the entry's author is one author row, agent or person                                                     |
| 3    | **Object threads.** A conversation can be anchored to an object: a doc, a file, a task, an extension's record. Doc comments (DOR-2983) land here. Extension sends land here once their receiving chat has a conversation (step 4); until then the ledger only shrinks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `extension_agent_chats`; `extension_agent_sends` down to idempotency keys                                                                                        | DOR-2983 doc comments; coordinate with the Docs programme before building, its contract is on that ticket                                                                          |
| 4    | **DMs become true rooms underneath, last.** Nothing changes on screen: the DM already looks like a room (§3.1). What moves is the record. At each turn boundary the DM's room log gains the person's words and the agent's finished reply: the turn's visible text blocks, in order, with its turn link, never tool output. **History stays readable:** past turns are backfilled into the log from the session transcript with their original times, written without dispatch (§2.1), and the view draws finished messages from the log from then on. **Streaming stays:** the reply in progress, Show work, Watch and the Work tab keep reading the session stream; at the turn boundary the streamed reply gives way to its entry without a re-render or a double. New topics become threads in the DM, each with its own seat keyed (room, thread root, agent). `chat_send` to a chat id, spin-off reports and extension sends move onto the log here. No new conversation kind is needed: one DM per member set, and parallel work is threads. | `chat_messages`; the Direct chat's special cases (pings drawn into the session stream, its own redirects); the remaining special cases for "a chat is a session" | navigation fix Phase 1 ships the look first, with no migration. after launch. everything-is-a-space B7 stays as specified: an away agent shows waiting messages, never its history |

**Step 2 and C4 must share one author model.** C4 makes a space message's author one member (agent or person). Step 2 makes an agent DM's entries authored by one local author row. They should land on the same author identity so a DM that later moves into a space keeps its authors. Step 2's design note is written against C4's, not beside it.

## 8. UX

**One shape, one feel.** Every conversation (channel, DM, group DM, Telegram, email, a doc's thread) uses the same entry, the same composer and the same states. Where they differ, it's density, never structure. A person who learns one learns all of them.

The five promises are requirements the build must keep. The design for each follows.

### 8.1 R1. People talk in DMs; the session view loses nothing

**Who's here no longer sets the view** (navigation fix, Dorian 2026-10-18; supersedes brief S12). A person always talks in a room. You and one agent make a **DM**. Add a member and it's a **group DM**. A **channel** is a room about a subject. The old 1:1 view is now the **Session** view, a power-user view of one agent's seat behind Settings › Show sessions (off by default). "Session" as the name is with Dorian.

- **The session view doesn't change.** It keeps reading the session stream (`GET /api/sessions/:id/events`): tools, thinking, todos, subagents, token-by-token streaming, model, account, context and compaction.
- **One DM per member set.** These all open the same DM, created on first need and never auto-archived:
  - the agent's row
  - Message on its hover card
  - Open chat on its profile
  - `relay_notify_user` pings
  - the `dm.received` notification
  - search hits
- **The DM looks like a room and runs on the seat's session (§3.1):**
  - a room header: face, name, working state, "Also in #…"
  - the room composer's look, with slash commands kept and no status line
  - the seat's session stream, so history, streaming and steps are all intact
  - each reply's steps folded into one line, "Worked · N steps · Show work". Thinking never shows inline, but it stays one click away in Show work and the Work tab.
  - asks and approvals inline
- **The right panel matches the session view's:**
  - Profile, Files, Canvas, Browser and Computer
  - a **Work** tab (§8.2 and §8.3 in panel form)
  - Terminal, with Show sessions on

  The agent comes from `oneToOneDmAgentRef(room)`. The panel shows the agent of the chat you're in (FB-60).

- **Coming from a channel:** Message carries the source entry into the DM as a chip ("↩ From #design · designer: …").
  - On send, the chip becomes a link entry at the top of the person's message, rendered as a quote card that jumps back to the source.
  - If the person dismisses the chip, nothing is posted.
  - The two seats stay separate sessions (§3.1). The link is how one learns of the other.
- **Parallel work:** **New topic** in the DM starts a separate session with the agent, with its own context. It shows in the DM as a card ("designer · Pricing review →"). At step 4 it becomes a thread with its own seat.
- **Typing in a session:**
  - **Behind a DM:** that session _is_ the DM, so nothing is lost.
  - **Behind a channel seat:** the reply stays in the session (§3.1). The view says so above the composer: **"Replies here stay in this session. They don't post to #design."**
    - Each finished reply gets **Post to #design**.
    - The posted entry is the agent's words with a quiet origin line, "Posted by Dorian from a session ↗" (§8.5 style, linking to the turn).
    - The person is recorded in the audit trail (C4).
- **The session view always names what it's behind:** "behind your DM with designer ↩" or "behind designer in #design ↩".
- **No flash, ever.** Phase 1 changes how Direct chats look and where clicks land, with no migration. Acceptance: all 16 Direct chats migrated on 2026-10-18 open in the DM view with full history, original times and streaming. At step 4 the record moves underneath with no visible change: history loads unanimated, with the same scroll position and no re-render of the past.

**Built ahead of step 4 (DOR-2997).** Until step 4 makes the room the record, the DM is built from what exists, and nothing is copied or deleted:

- **The room stays as the log underneath.** The operator-plus-one-agent `dm` room (found or made by its exact member set, `dm_member_key`) keeps every entry. `relay_notify_user` still posts there, so `read_room_history` and `post_to_room` keep working for agents, and search, the audit trail and read cursors keep keying on it.
- **The Direct chat is the agent's seat session in that room** (`room_sessions`), minted on first need. It opens in the DM view (above). Room turns already in it read as the person's message and the agent's work (DOR-2113 stamps).
- **Entries that never opened a turn** (pings, and posts the agent made into this DM from its other chats) are drawn in the stream at their real time, unanimated, as ordinary messages from their author: a ping is the agent talking to the person, so it gets the avatar, name and body of any reply. (Showing a link to a work chat as a chip under it is still to come.) Only entries in this DM room appear; the agent's posts in other rooms never do. Opening the chat scrolls to the first unread ping under the "New messages" divider. The person's DM messages go to the session, not the room, until step 4.
- **The agent's next turn there gets the notes it hasn't seen**, fenced, so a reply to a ping has its context.
- **Every door redirects.** The agent's row, Open chat, Today's DM item, the `dm.received` notification, search hits and any old `/channels?id=` link for such a room open the DM view, replacing the URL so Back does not bounce. Opening it marks the room read.
- **A room that gains a member is a room from then on.** The next ping finds no two-member DM and makes a fresh one, and so a fresh Direct chat.
- **Only the owner has Direct chats.** Anyone else's click on an agent still opens that agent's latest chat with them.
- **The fold is forward-only and idempotent by construction:** no rows move, so there is nothing to undo and nothing to repeat.

### 8.2 R2. Every reply links to its turn: "Show work"

- **Affordance:** on hover or focus of any agent entry, the entry's action row gains **Show work**. It's also in the entry's context menu. Like all chrome, it's hidden at rest.
- **Where it opens:** the right side panel, the same panel Watch uses (8.3), showing that one turn: its tools, thinking and subagents. Other turns of the session are collapsed above and below as "Earlier" and "Later" rows, so the turn sits in context without the whole transcript.
- **Who sees it:** only readers who may read that session (open item 4). For everyone else the action is **absent, not disabled**, so a closed door isn't advertised.
- **Keyboard:** with an entry focused, `Enter` opens its actions and Show work is one of them. `Esc` closes the panel and returns focus to the entry.
- **In a DM** Show work sits on every agent reply, beside its "Worked · N steps" line. **In the session view** it isn't needed, because the work is already inline.

### 8.3 R3. Watch

- **Where it starts:** the room's "working" indicator for an agent (today's live peek) becomes a button: **Watch @designer**. Clicking it opens that agent's live turn in the right panel. It never opens by itself.
- **What it shows:** the turn exactly as the session view shows it, streaming: text, tools, thinking. It auto-follows the newest line until the person scrolls up; a "Jump to live" pill brings it back.
- **When the turn ends,** the panel stays open on the finished turn. Its post lands in the room whole, as always. A **Posted ↗** link in the panel scrolls the room to that entry and briefly highlights it (a 150ms tint in, fading over 1s).
- **One panel, one agent.** Watching another agent swaps the panel's content with a 150ms crossfade, and a small switcher lists every agent working now.
- **Calm for everyone else:** watching is private to the watcher. It posts nothing, notifies nobody and doesn't change what the agent does.
- **Motion:** the panel enters from the right at 200ms ease-out and exits to the right at 150ms ease-in, using the existing side-panel spring. Under reduced motion it appears and leaves instantly, and streamed text never animates per token.
- **Watch and Show work are one component** in two modes, live and finished, so a turn looks the same wherever it's opened.

### 8.4 R4. Queued is visible

A sender's own entry carries one quiet status, read from the per-turn delivery record (§2.2), never a stored flag. "Replied" means a reply from a turn that saw the message, or an entry that names it as its parent.

| Status    | At rest                                        | On hover or focus                    |
| --------- | ---------------------------------------------- | ------------------------------------ |
| Queued    | a hollow dot beside the time, muted            | "Queued · 2 ahead"                   |
| Delivered | a filled dot, muted                            | "Delivered · in @designer's context" |
| Replied   | none; the reply is the signal                  | "Replied" and a link to the reply    |
| Failed    | **shown inline:** "Not delivered: why · Retry" | the full reason                      |

- **Failed is the only state that uses colour** (the destructive token, text only, no border or fill), and the only one that shows words at rest.
- **The words "Sent" and "Delivered" are never shown for something that could still be lost.**
- **Screen readers** get the status as text on the entry (`aria-describedby`), not just a dot.
- **Agent senders get the same states** in their tool results, worded the same way, so people and agents read one vocabulary.

### 8.5 R5. Outsider words look like outsider words

- **Origin under the name:** an outside sender's entry shows a quiet origin line under the author name, for example "via Telegram", "via email · priya@example.com" or "via Slack · #launch", in the muted text token. No coloured border or badge colour (house style: no decorative borders).
- **Email bodies render calm:**
  - Quoted history and signatures collapse into a "Show quoted text" row.
  - Remote images stay blocked until the person clicks "Load images".
  - Attachments show as attachment chips.
- **Unvouched senders** (no "this email is me" link) get a small "Not verified" in the origin line, with the reason on hover.
- **Replies that go outside** show the bridge as a destination in the composer ("Replying by email to Priya"), so a person always knows their words leave DorkOS. Where the trust rules need a yes, the composer asks before it sends.

### 8.6 Addresses in the UI (supports §6)

- **Copy address:** in each conversation's header menu, it copies the display form (`marketing+launch@acme`), or the email form where email is on.
- **The picker:** a new message's "To" field takes `@agent`, then `›` to choose one of that agent's named conversations, or "New conversation". The same picker serves `chat_send` targets in the UI.
- **Long handles** truncate in the middle (`marketing+lau…ch@acme`), never at the end, so the Space stays visible.

### 8.7 Edge states

- **Turns run outside DorkOS** (open item 2): the log shows one quiet line where entries are missing, for example "2 turns ran outside DorkOS · Open the session", rather than a silent gap.
- **Empty conversation:** the composer and one line saying who's here. There's no illustration.
- **A remote Space offline:** cached entries stay readable with an "Offline · showing what this computer has" line, and the composer queues locally with each entry marked Queued (8.4).
- **Both themes, AA contrast and keyboard paths** are checked for every state above before each step ships. A design review screenshot set goes with each step's PR.

## 9. Email (designed here, not built)

Email is a bridge onto a conversation, the same shape as Telegram and Slack after step 1. Nothing here is built by this spec; it fixes the shape so the conversation model does not have to change when email arrives. Background: `research/20261006_email-phone-first-class.md` (§4 and the `ContactProvider` port).

- **One port, `EmailProvider`**, with the research's verbs: provision an address, send, receive (a cursor, so a closed lid loses nothing), release. Receive is required; live push is optional.
- **DorkOS Cloud's provider:** inbound through Cloudflare Email Routing to a Worker, which stores each message until the app pulls it over the cloud link; outbound through Resend, signed with DKIM. Each space gets its own subdomain under one registrable mail domain kept apart from dorkos.ai, so one space's bad sending cannot hurt another's reputation or the product's own mail. (The domain is not chosen yet.)
- **Self-hosters bring their own mailbox:** IMAP and SMTP, or Gmail. A laptop is never a mail server: inbound always lands somewhere always-on first, outbound always goes through a relay.
- **Inbound is a bridge entry.** A message to `{handle}[+{name}]@{space}.{mail domain}` resolves to one conversation (§6) and lands as an entry with an external origin, authored by the outside sender. The agent reads it fenced as outsider words, exactly like a stranger's Telegram message: information, never orders (`<working_rules>`).
- **Mail threads map to threads.** `Message-ID`, `In-Reply-To` and `References` map to entry threads, kept in a helper table beside the log the way `room_bridge_messages` maps Telegram and Slack message ids.
- **Outbound is a post.** An agent's entry in an email conversation is sent as a reply on the same mail thread. Sending to someone outside the team still needs a person's yes where the trust rules say so.

The public repo names these services as architecture only. Costs, plans and supplier terms stay out of it.

## 10. Open items

1. **Per-space handles** (§6).
2. **A turn run outside DorkOS** (bare CLI resume) writes no entries. Backfill on the next DorkOS turn, or leave the log short and say so in the view.
3. **Log growth.** The log is never trimmed; 1:1s multiply its size. Decide retention for a log, not for a transcript, before step 4.
4. **Who may read a turn** behind an entry (R2) when the reader is a member of the conversation but not the session's owner. Rooms answer this today for the peek; 1:1s and spaces need the same rule. **This blocks R2:** until the rule exists, Show work is absent, not disabled (§8.2).
5. **Mirror cache keys** for remote spaces: confirm the remote conversation id can be the local key without a second mapping table.
6. **Bindings step 1 does not cover:** wildcard bindings, unknown group chats, the `per-user` and `stateless` strategies, and whether "Answer privately" survives.
   Proposed answers (designer, pending Dorian):
   - **"Answer privately" survives as visibility, not as a storage mode.** Every claimed chat gets a log; "privately" means only the claimer and the agent can see it, and it can be moved to a channel later with its history.
   - **Wildcard bindings:** each new outside chat gets its own conversation on its first message (the §6 front-door rule).
   - **`per-user`:** one conversation per outside user.
   - **`stateless`:** the log is kept; only the session is fresh each message.
   - **Unknown group chats:** held as unclaimed until the type is known, then they become a shared conversation.
