# Spin-off chats: chats message each other like people do

**Linear:** DOR-2790 (Urgent). **Decided by:** Dorian, 2026-10-08. Kept short on purpose: the design was settled on the ticket, so this records it rather than exploring it.

## The problem

- Agents can start chats (`session_start`) but cannot send to a chat that already exists. The coordinator POSTs to `/api/sessions/:id/messages` by hand, which records the turn as `interactive`, shows it as "You", hides from the receiver that an agent sent it, and runs it at the chat's full stored power.
- Nothing tells a parent chat that a spin-off it started has finished, failed or got stuck.
- The relay agent tools (`relay_send`, `relay_send_and_wait`, `relay_send_async`, `relay_inbox`) sit on the Maildir store that ADR 261006-235240 retires, and nobody can follow what they carry.

## The words

- **Chat:** a conversation with an agent.
- **Spin-off chat:** a full chat another chat started. You can open it, read it and type in it. It lasts hours or days and survives restarts.
- **Helper:** a worker inside one chat (a subagent). You cannot open it or talk to it. It reports once and ends in minutes.

Never "helper chat"; never call a helper a spin-off.

## The shape (decided)

1. `chat_send`, `chat_read`, `chat_stop`: capabilities every runtime gets through the DorkOS tools.
2. A new turn origin, `chat-message`, stamped with the sending chat and agent, and held to the sender's level.
3. Queue by default; steer and interrupt opt in; the person's queued words run before agents'; agent messages waiting together run as one turn.
4. **No loop guard and no turn cap.** Chats may talk for days, weeks or months with no person in between (Dorian, 2026-10-08).
5. **Agents can do what people can.** An agent may stop or interrupt any chat it can reach; each stop is in the audit trail and shown in the stopped chat (Dorian, 2026-10-08).
6. Spin-offs report back on their own when a turn ends finished, failed, needing the person, or paused at a limit; never when it ends only to wait.
7. The relay agent tools retire; the rest of Relay stays.
8. Messaging renders as conversation and never hides behind the tool-call toggle.

The specification is [`02-specification.md`](02-specification.md).
