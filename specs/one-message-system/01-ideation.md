---
slug: one-message-system
number: 261126-004719
created: 2026-11-25
status: specified
---

# One message system

**Slug:** one-message-system
**Linear:** DOR-2744
**Decision:** ADR [`261017-211859`](../../decisions/261017-211859-a-conversation-is-the-shared-log-a-session-is-private.md) (a conversation is the shared log; a session is private), which amends ADRs `261006-235240`, `261009-171114` and `0013`
**Roadmap:** `meta/ROADMAP.md` item 17. Needs item 5 (spec [`turns-survive-restarts`](../turns-survive-restarts/02-specification.md): the turn port, the run record, the outbox, and the steps that move Relay's and the scheduler's turn starts onto the port). Uses item 9's removal of the inbound webhook (spec [`one-wake-and-watchers`](../one-wake-and-watchers/02-specification.md), step O6) and item 10's A2A rebuild and seat table (spec [`send-to-an-agent`](../send-to-an-agent/02-specification.md), steps D6, D7 and D12).
**Status:** specified. The plan is [02-specification.md](02-specification.md). It re-reads the older draft, [`conversation-model`](../conversation-model/02-specification.md), and gives each of its steps a verdict.

## What and why

What was said in a chat lives in about nine places today, depending on the kind of chat: a runtime's own transcript, the room log, the chat-message table, a mini app's send table, Relay's Maildir mailboxes, Relay's session maps and the bridge tables. Three different things start a turn for a message: the dispatcher, the room trigger, and Relay's own Claude Code piece. So one question ("what was said here, by whom, and did the other side get it?") has a different answer on each surface, and one answer was wrong: `chat_send` once reported a message delivered that never reached the receiver.

ADR `261017-211859` settles the model. A conversation is the shared log. A session is one agent's private working context behind it. A seat joins the two. Relay stays as the delivery engine to outside windows, and its Maildir store retires. This spec builds that, one kind of chat at a time.

## What is built today

| Piece                                                                   | State                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The room log (`room_entries`), seats (`room_sessions`) and read cursors | Built; rooms, channels and the Direct chat's posts use it                   |
| Telegram and Slack chats in room mode                                   | Built; the chat bridge writes room entries and starts no turn               |
| Telegram and Slack chats in the default mode                            | Words go to the agent's session through Relay; no log                       |
| Agent-to-agent messages                                                 | Words in `chat_messages`; the receiving chat found through `chat_agent_dms` |
| A mini app's messages                                                   | Words held in `extension_agent_sends` until the turn takes them             |
| The run record, the outbox, the turn port's door                        | Built in item 5 (T1 to T5); rooms, tasks and Relay are not on the port yet  |
| A record of which entries a turn was shown                              | None. The run record has a delivered time and no entry list                 |
| A check that nothing new is stored in Maildir                           | None; review holds it                                                       |

## What the spec settles

- **The invariants**: one log; a session is private; delivery is a record; no double feed; one way to start a turn; a run never handed an entry whose mark or level differs from its own; nothing new in Maildir; the chat-message rules unchanged; nothing lost on upgrade; the log stays where it is; the frozen space code left alone.
- **The delivery record**: kept with the run record, one row for each entry a turn was shown, and what "delivered", "replied" and "failed" mean.
- **Two ways in**: in a room-style conversation a post is an entry at once; words that wait in a composer stay queue rows, as today, and the space side writes them as entries when a turn takes them.
- **A count that only falls** of the places that can put words into Maildir, and the conditions for Maildir to retire.
- **Relay after this spec**: what it keeps (the connections to outside windows, their retries, limits and receipts) and what it gives up (starting turns, Maildir, its session maps, agent and task subjects).
- **Each kind of chat, in order**: outside chats (every binding strategy), agent-to-agent messages, a mini app's and an object's thread, notices that ride Relay, and 1:1 chats last, as a conversation kind of their own.
- **A verdict** on every step, rule and UX section of the older draft.

## What is left to later parts

- Moving the log to the space store (roadmap item 16).
- Who may message whom, block and mute, and messages between spaces.
- Email.
- How long a log is kept (retention), decided before the 1:1 step.
- Loop limits for agent-to-agent messages (DOR-2745).
- The A2A rebuild (item 10's D12) and the inbound webhook's removal (item 9's O6), which this spec needs and does not redo.
