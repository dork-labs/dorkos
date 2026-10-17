---
id: 261017-211859
title: A conversation is the shared log; a session is one agent's private context seated behind it
status: proposed
created: 2026-10-17
spec: conversation-model
superseded-by: null
amends: [261006-235240, 261009-171114]
---

# 261017-211859. A conversation is the shared log; a session is one agent's private context seated behind it

## Status

Proposed (operator direction 2026-10-17, relayed by the designer agent; spec `specs/conversation-model/`). Becomes Accepted when Dorian approves the spec.

**Extends** [260726-170125](260726-170125-a-room-is-a-membership-scoped-durable-stream.md) (a room is a membership-scoped durable stream, not a session) from rooms to every chat. That ADR's decision is unchanged; this one says it now holds everywhere.

**Amends:**

- [261006-235240](261006-235240-one-message-system.md) (one message system): its "messages will live in the conversation store" stands and this record names that store. Its retirement of Relay's Maildir does not: Maildir stays as the internal delivery bus. Once user-visible words live in the log, no new words a person reads live only in Maildir; its old `relay_send`-era rows are archived as they are, not imported.
- [261009-171114](261009-171114-chat-message-origin-and-delivery-rules.md) (chat-message origin and delivery rules): every rule stands (stamped sender, nonce fence, downstream power, queue by default, the person first, no loop guard). What changes is where the words live: a chat message becomes an entry in the receiving conversation's log, and `chat_messages` folds into it.

## Context

DorkOS keeps what was said in at least six places: Claude Code transcripts, `session_events`, `room_entries`, `chat_messages`, `community_mirror_entries` and `extension_agent_sends`, plus Relay's Maildir and the Telegram and Slack bridge tables. Rooms already have the right shape: one durable log (`room_entries`) with members and threads, and one private session per agent behind it (`room_sessions`). A 1:1 chat, an agent-to-agent message, a Telegram chat in the default (non-room) mode and an extension's send each use a different shape. So one question ("what was said here, by whom, and did the other side get it?") has a different answer per surface, and some answers are wrong: DOR-2994 found `chat_send` reporting a message delivered that never reached the receiver.

## Decision

**A conversation is the shared log. A session is one agent's private working context, seated behind a conversation.**

- **A conversation** has an id, members (people, agents, outside senders), a log of entries, and threads (a thread is a relation between entries, per 260728-022013). The log is DorkOS-owned, durable, turn-atomic and never trimmed. It is what every member, and every window onto the conversation (the app, Telegram, Slack, email), reads.
- **A session** is the runtime's own transcript and state: tools, thinking, todos, subagents, token streams. It is private to its agent. It is never the record other members read.
- **A seat** joins them: one agent, one conversation, one session, one read cursor. Rooms already store seats as `room_sessions`.
- **One storage shape for every chat.** Channels, agent-to-agent DMs, bridged Telegram and Slack chats, email threads, object threads and, last, 1:1 chats all become conversations. `room_entries` (with its reactions and attachments) becomes the log for all of them.
- **No double-feed.** A session resumes its own transcript. A new turn is given only the entries the seat has not read and that this seat's session did not write. A backfill writes without dispatch and moves the seats past it.
- **Delivery is a record, not a flag.** Each turn writes a delivery record: the entries actually shown to the agent, when the runtime accepted the turn, and why it failed if it did. "Delivered" means a turn the runtime accepted showed the entry. "Replied" means a turn that was shown it produced a reply, or an entry names it as its parent. The read cursor only says what is unread; it moves at claim, before the runtime is asked, so it cannot prove delivery.
- **Every reply links to its turn.** An entry an agent writes records the session and turn that produced it (a dispatch id plus a runtime anchor, because no runtime-neutral turn id exists).
- **The chat-message rules carry over.** Power flows downstream (a turn runs no looser than the tightest chat-message entry it shows), the person first, and no loop guard or turn cap on agent DMs until DOR-2745 decides.
- **One address points at one conversation.** `{handle}[+{name}]@{space}` renders the canonical `dork://{space}/{handle}/{conversation}`.
- **Kept beside the log, as helpers:** `session_message_queue`, `room_bridge_messages`, Relay's Maildir, and the message search index (re-pointed at the log). Notifications, commitments and the audit trail stay their own stores.
- **Remote spaces keep their own truth.** A conversation in a space whose server is elsewhere stays authoritative there (260916-210002); the local rows are a mirror cache keyed to the same conversation id.

## Consequences

### Positive

- One answer to "what was said here": the log, on every surface and every runtime.
- Delivery receipts cannot lie, because they are read from what each turn actually showed and whether the runtime accepted it.
- Bridges, email and agent DMs inherit what rooms already have: threads, reactions, attachments, read cursors, search and Stop. (Room turn budgets do not apply to agent DMs; ADR 261009-171114 refused a loop guard.)
- Mixed runtimes stay possible everywhere, because the conversation never picks a runtime.
- Addresses become possible: a conversation id is something an email address or a link can point at.

### Negative

- **A 1:1 chat gains a second record.** The person's words and the agent's replies are in the log and in the transcript. The 1:1 view keeps reading the transcript for live detail, so the two must agree on turn boundaries, and a turn run outside DorkOS (a bare CLI resume) writes no entries until DorkOS sees it. The second record is invisible to the person (spec §8.1): nobody should "fix" it by showing both.
- **A 1:1 needs a new conversation kind.** A DM is one per member pair; a person has many chats with one agent, so 1:1s are a `chat` kind.
- **A real migration.** `chat_messages`, Telegram and Slack chats in the default mode, `extension_agent_sends` and old agent DMs must be backfilled or retired without losing history, in four steps over several releases.
- **Handles are unique per install today.** Addresses across spaces need per-space handles, which this record leaves open.
- **The log grows faster.** Every 1:1 turn adds entries. The log is never trimmed, so its size is now a product concern.

## Alternatives considered

- **Make the session the conversation everywhere** (multiplex members inside a session). Rejected for the reason 260726-170125 gives: a session is bound to one runtime at first write, so a mixed-runtime conversation has no session that could own it.
- **Keep per-surface stores and add a unified read view over them.** Rejected: it hides the drift instead of removing it. Receipts would still be written in one store and the words in another, which is how DOR-2994 happened.
- **Retire Relay's Maildir now, as 261006-235240 planned.** Not now: it is the internal bus and it works. Once user-visible words live in the log, Maildir carries only delivery, so nothing has to be imported out of it.
