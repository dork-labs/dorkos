---
id: 261009-171114
title: Chats message chats with a stamped chat-message origin; queue by default, person first, no loop guard
status: accepted
created: 2026-10-09
spec: spin-off-chats
superseded-by: null
amends: [261006-235240, 0077, 0081]
---

# 261009-171114. Chats message chats with a stamped chat-message origin; queue by default, person first, no loop guard

## Status

Accepted (operator decision, 2026-10-08; Linear DOR-2790).

**Amends:**

- [261006-235240](261006-235240-one-message-system.md) (one message system): agent-to-agent messages now travel as chat messages, which people can read, instead of through `relay_send`. Its "loop limits between agents" safety item is deferred: the operator ruled out a loop guard or turn cap for chat messages (below). Telegram/Slack adapters and the rest of Relay are untouched and still retire on that ADR's schedule.
- [0077](0077-relay-dispatch-fire-and-poll-for-long-running-tasks.md) and [0081](0081-in-process-progress-aggregation-for-relay-query.md): fire-and-poll and send-and-wait over Relay inboxes are replaced by `chat_send` + `chat_read`; the tools they describe are removed.

## Context

An agent could start a chat (`session_start`) but not send to one that exists. A coordinator POSTed to `/api/sessions/:id/messages`, which records `interactive`: the message showed as "You", the receiver could not tell an agent sent it, and the turn ran at the chat's full stored power. Spin-offs never reported back. The relay agent tools carried agent-to-agent traffic where no person could follow it.

## Decision

- **A new turn origin, `chat-message`.** It seeds no operator stop. Every send writes a `chat_messages` row: sending chat and agent, receiving chat, kind (`message`, `report`, `start`), the fence nonce, the ceiling, and the delivery state.
- **The sender is stamped by the server, never typed.** The receiving agent reads the words inside a nonce fence naming the sending agent and chat. The app shows a sender only where a fenced block's nonce matches a row for that chat, so a typed-in fence stays plain text.
- **Power flows downstream.** A chat-message turn runs no looser than the sending chat's latest turn, read at send time and kept on the row; unknown is the receiving runtime's default. The ceiling is applied when the row launches, so it survives the queue and a restart.
- **Queue by default.** Never interrupt; an idle receiver starts at once (that is how a parent wakes). `steer` and `interrupt` are opt-in.
- **The person first.** A person's queued message is placed ahead of agent-sent ones. Agent messages that wait together run as one turn.
- **No loop guard and no turn cap.** Chats may talk to each other for days, weeks or months with no person in between. Loop protection, if it comes, is its own decision. The machine-load launch cap still applies; a send it refuses is answered with the reason, and the sender tries again.
- **Agents can do what people can.** An agent may stop or interrupt any chat it can send to, like the Stop button. Each stop is recorded in the audit trail and shown in the stopped chat with who did it. An agent's stop never erases a person's queued words.
- **Spin-offs report back by themselves** when a turn ends finished, failed, needing the person, or paused at a limit; never when it ends only to wait.
- **The relay agent tools retire:** `relay_send`, `relay_send_and_wait`, `relay_send_async`, `relay_inbox` and the endpoint tools only they used.

## Consequences

### Positive

- Every message between agents is in a chat a person can open, with who sent it on it.
- A parent hears from its spin-offs without remembering to ask.
- One way to send, the same on every runtime.

### Negative

- With no loop guard, two agents can keep each other busy indefinitely and spend usage doing it. A person sees it in both chats and can stop either; nothing stops it for them.
- The sender stamp depends on a server row; a chat whose rows were deleted shows old agent messages as plain text.
- Read access is narrower than send access until roles exist: an agent may message a chat it cannot read.
