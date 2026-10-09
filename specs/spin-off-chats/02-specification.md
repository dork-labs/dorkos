# Spin-off chats — specification

**Linear:** DOR-2790. **Ideation:** [`01-ideation.md`](01-ideation.md). **ADR:** [`261009-171114`](../../decisions/261009-171114-chat-message-origin-and-delivery-rules.md).

Four PRs, each titled with DOR-2790, in this order: (1) server, (2) automatic report-back, (3) the UI, (4) retiring the relay agent tools plus the skill and docs.

## 1. The three tools

Declared once each as capabilities in a new `chat` domain (`apps/server/src/services/session/chat-messages/`), so every runtime gets them through the DorkOS tools: Claude Code through its in-session server, Codex, OpenCode and Doe through the authenticated runtime listener. They are `in-session` only. The caller is always the verified turn (`context.sessionId` + `context.identity`), never an argument: a tool with no calling chat refuses, because the sender stamp IS the calling chat.

Area `messages` (Messages: "Message other agents, and message you"), tier `act`. Allowed in every preset, as today's relay tools are.

### `chat_send({ to, message, summary?, delivery?, replyTo? })`

- `to` is a chat id or an agent id.
  - A **chat id** posts into that chat. It must be a chat this server has bound, and not a room's conversation, a bridged Telegram/Slack chat or a scheduled run (`CHAT_SENDABLE_ORIGINS`; `null` origins refused, same rule as `ctx.agent.send`).
  - An **agent id** posts into the sender agent's own DM chat with that agent (`chat_agent_dms`, keyed by sender agent and receiver agent), opening one in the receiver's home on the first message.
  - Sending to your own chat is refused (`SELF`).
- `message`: markdown, 1 to 20,000 characters.
- `summary`: optional, at most 80 characters. The Sent card's one-line label. Absent: the message's first line, trimmed.
- `delivery`: `queue` (default) | `steer` | `interrupt`.
- `replyTo`: optional id of the chat message this answers, so both sides can thread.
- Returns a receipt: `{ messageId, chatId, status, position?, note? }`, `status` one of `queued | delivered | steered | interrupted | failed`.

### `chat_read({ chat, since?, last?, include?, maxChars?, query?, cursor? })`

- `chat`: a chat id the caller may read (§4).
- Returns `{ chat: { id, title, agent, state, limit? }, messages: [...], more: boolean, cursor? }`.
- `state`: `running | needs-you | done | failed | stopped | paused-at-limit | idle`.
- `since`: `'last-read'` (default; a per-reader cursor in `chat_read_cursors` keyed by reader chat and target chat), a message id, or an ISO time.
- `last`: the newest n messages instead (default 10, max 100). `since` and `last` together: the newest `last` after `since`.
- `include`: `text` (default; the person's and agents' words), `tools` (also tool calls, one line each), `status` (no messages: the cheapest check; does not move the cursor).
- `maxChars`: default 8,000. When the page would pass it, the last message that fits is trimmed and `cursor` says where to continue (`<messageId>:<offset>`). Passing `cursor` continues from there.
- `query`: only messages matching the words, through the message search index (`searchMessages`, one container scope on the target chat). The cursor is not moved.
- A received chat message reads as `{ from: { chatId, agentId, agentName, chatTitle }, kind, text }`, never as the raw fence.

### `chat_stop({ chat, reason? })`

- Stops a running turn exactly as the Stop button does (`runtime.interruptQuery`), and drops queued messages OTHER chats sent there. The person's own queued words stay and run next: an agent's stop never erases what a person typed.
- `reason`: optional, at most 200 characters.
- Recorded in the audit trail (`chat.stopped`), and shown in the stopped chat as "Stopped by <agent> · <chat>: <reason>" (a durable `chat_notice` event on its stream).
- Any chat the caller may send to (§4) may be stopped. Stopping your own chat is refused (`SELF`): end your turn instead.

`session_start` stays. Its first message gets the same sender stamp, and it gains `reportBack: 'auto' | 'off'` (default `auto`, PR 2).

## 2. The `chat-message` origin and the sender stamp

- `TurnOrigin` gains `{ kind: 'chat-message' }`. It seeds no operator stop (`permissionSeedForOrigin` → `'none'`), like `agent-launch`: a chat it opens gets no power of its own beyond the ceiling below. `MESSAGEABLE_ORIGINS` for extensions gains it (a DM chat an agent opened is a person's-side chat like `agent-launch`).
- **What the receiving agent reads** (`renderChatMessage`): one constant line outside the fence ("This message is from another chat, not from the person."), then a nonce fence labelled `CHAT MESSAGE` whose first lines name the sender agent, its id, the sending chat's title and id, and the kind (`message`, `report`, `start`), then the words. Sender names are reduced with `sanitizeIdentity` and placed inside the fence; marker lookalikes in the words are neutralised.
- **What the person sees** comes only from the server: a `chat_messages` row is written for every send with the fence nonce. The wire boundaries (`GET /api/sessions/:id/messages`, the `/events` snapshot, live `turn_start` and `turn_input`) look up each fenced block's nonce for THAT chat and attach `chatMessages: ChatMessageStamp[]` to the message. A block with no matching row is shown as the plain text it is, so nobody can forge a sender by typing a fence.
- The lock identity is `chat:<sendingChatId>`, so a queue row says which chat sent it.

## 3. Delivery rules

- **Queue (default).** Never interrupts. A busy receiver holds the message in `session_message_queue` until its turn ends; an idle receiver starts a turn at once, which is how a parent wakes.
- **Person first.** A person's message enqueued behind agent-sent rows is moved in front of the first one. The order the queue shows is the order it runs; a person may still reorder by hand.
- **Batch.** An agent message enqueued while the queue's last row is another agent-sent row from within `CHAT_BATCH_WINDOW_MS` (2 minutes) of it is appended to that row (`updateContent`), so they run as one turn. Each keeps its own `chat_messages` row and fence.
- **Steer (opt-in).** The dispatcher's `steer` disposition. A runtime that cannot steer falls back to the queue; the receipt says `queued` with a note.
- **Interrupt (opt-in).** Stop the receiver's running turn (the agent's queued messages there stay), then deliver at the head of the queue.
- **The level ceiling.** A `chat-message` turn runs no looser than the sending chat's latest turn (`lastTurnLevelOf`), captured at send time and stored on the row; unknown is `runtime-default`. A batched turn is held to every sender's bound (a list ceiling). The ceiling is applied when the queued row LAUNCHES, read from `chat_messages` by queue row id, so a row adopted after a restart keeps it; an agent-sent row with no record runs at `runtime-default` (fails closed).
- **No loop guard, no turn cap** (Dorian 2026-10-08). The launch cap (`AGENT_LAUNCH_MAX_LIVE`) still counts a send that starts a turn on an idle chat, because it limits machine load, not conversation; a send refused by it is held and retried, never dropped.
- **Notifications.** A turn started by a chat message never sounds the turn-finished notification for the person (it is not their turn).

## 4. Who can reach what

- **Send and stop:** any chat in `CHAT_SENDABLE_ORIGINS` (agents are trusted by default, ADR 261006-225605; anyone in a space may message anyone, ADR 261006-235240).
- **Read:** the chats a person in its role could read is the rule, and until roles exist it is the chats linked to the caller: its own chat, the chat that started it, chats it started (and theirs, down the chain), and chats it has exchanged chat messages with. Not widened beyond that here.

## 5. Automatic report-back (PR 2)

- When a spin-off's turn ends **finished, failed, needing the person, or paused at an account limit**, the server sends its last assistant message to the chat that started it, kind `report`, `queue` delivery, from the spin-off.
- A turn that ends while background work is still running (a helper, a CI watch, a timer) is waiting, not finished: nothing is sent, and the report follows the later turn that ends with no background work (`followLateTurns`).
- `session_start({ reportBack: 'off' })` turns it off for that spin-off. Stored on `session_started_by`.
- The spin-off's first-turn context names its parent and says to send milestones with `chat_send` without being asked.

## 6. The UI (PR 3)

- **Sending chat:** `chat_send`, `session_start` and `chat_stop` calls render as a "Sent" card, never as tool calls: never hidden by auto-hide, never folded into a tool group. Closed: the receiver's avatar, a send icon, "To **<agent>** · <chat>", the summary, the time and a live state (Queued #n, Delivered, Steered in, Interrupted then delivered, Working, Replied, Failed: reason). Open: the full message, the receipt in plain words, "Open chat →". Starting a spin-off: "Started spin-off chat · <title>". Stopping: "Stopped <chat> · <reason>".
- **Receiving chat:** a full message in the same layout as the person's, with the sender's avatar and name, "from <chat>" linked to the sending chat (scrolled to its Sent card), a tint that differs from the person's own, tags "steered in" / "interrupted" / "Report". Never "You".
- **Stopped by another agent:** a system line "Stopped by <agent> · <chat>: <reason>".
- **Threading:** a reply shows "Reply to your message" linking to the card it answers.
- Designed in the Dev Playground first; checked at desktop and mobile widths, light and dark.

## 7. Retiring the relay agent tools (PR 4)

- Remove `relay_send`, `relay_send_and_wait`, `relay_send_async`, `relay_inbox`, and the two endpoint tools only they needed (`relay_register_endpoint`, `relay_unregister_endpoint`). `relay_notify_user`, `relay_list_endpoints`, adapters, bindings and the rest of Relay stay; ADR 261006-235240 retires those later.
- The `<relay_tools>` block teaches `chat_send`/`chat_read` instead; `AGENT_TO_AGENT_TOOLS` becomes `mesh_list`, `mesh_inspect`, `chat_send`, `chat_read`.
- A first-party operating skill, `working-with-spin-off-chats`: when a helper vs a spin-off; how to brief one (goal, done-means, keep the turn alive while waiting, report back); how to check on and message one.
- Docs: `meta/VOICE.md` words, `meta/PROACTIVE-AGENTS.md`, a docs guide replacing the relay-messaging tool section.

## 8. Done means (tests pin each)

The sender stamp on every runtime; the "From…" rendering; queue by default and person first; batching; steer, interrupt and `chat_stop` shown in both chats and the audit trail; `chat_read` with each option; messaging cards visible with tool calls hidden; the level ceiling (including after a restart); report-back on finish, fail, needs-you and limit, and silence on waiting; the relay agent tools gone. End to end on a real app: a coordinator starts a spin-off, messages it, the spin-off finishes, and the parent wakes with its report.
