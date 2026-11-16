---
title: 'Relay adapters audit — multi-participant chat semantics in Slack and Telegram'
date: 2026-07-27
type: codebase-audit
status: active
tags: [relay, slack, telegram, group-chat, trigger-policy, loop-prevention, rooms]
feature_slug: room-participation
---

# DorkOS Relay Adapters — Multi-Participant Chat Semantics Audit

Read-only audit of the Slack and Telegram relay adapters (`packages/relay/src/adapters/slack/`, `packages/relay/src/adapters/telegram/`) plus shared relay infrastructure (`packages/relay/src/`) and the session-binding layer (`apps/server/src/services/relay/binding-router.ts`). All claims are cited to `file:line` in actual source, verified by reading the files directly — nothing inferred from `specs/` or `research/` docs (those were used only as leads to check, and discrepancies against them are noted explicitly).

Every path below is repo-relative to the DorkOS monorepo root.

---

## 1. Trigger policy

### Slack

Decision function: `shouldProcessMessage()`, `packages/relay/src/adapters/slack/inbound.ts:248-267`:

```ts
function shouldProcessMessage(
  mode: RespondMode,
  event: SlackMessageEvent,
  botUserId: string,
  threadTracker?: ThreadParticipationTracker
): boolean {
  if (mode === 'always') return true;
  const mentioned = hasBotMention(event.text ?? '', botUserId);
  if (mode === 'mention-only') return mentioned;
  // thread-aware mode
  if (event.thread_ts) {
    return mentioned || (threadTracker?.isParticipating(event.channel, event.thread_ts) ?? false);
  }
  return mentioned;
}
```

Mention predicate, `inbound.ts:236-238`:

```ts
function hasBotMention(text: string, botUserId: string): boolean {
  return text.includes(`<@${botUserId}>`);
}
```

Three modes (`RespondMode`, `inbound.ts:103`): `'always' | 'mention-only' | 'thread-aware'`. Default is `'thread-aware'` (`packages/shared/src/relay-adapter-schemas.ts:126`, and `slack-adapter.ts:98`), configurable globally and per-channel (`getEffectiveChannelConfig`, `inbound.ts:106-135`).

- `always`: every channel message.
- `mention-only`: only when `<@BOTID>` appears.
- `thread-aware` (default): in the main channel, @mention required; inside a thread, @mention **or** the bot already participated in that thread (`ThreadParticipationTracker.isParticipating`, marked on outbound delivery — `outbound.ts:274-277`, `stream.ts:186-195`, `approval.ts:161-164`).

This gate applies only to non-DM channels — `inbound.ts:534-547`:

```ts
if (!isDm) {
  const effectiveMode = ...;
  if (!shouldProcessMessage(effectiveMode, event, botUserId, options?.threadTracker)) {
    logger.debug(`inbound skipped: respond mode '${effectiveMode}' filtered ${channelId}`);
    return;
  }
}
```

**DM behavior differs entirely**: `isDm = channelId.startsWith('D')` (`inbound.ts:503`). DMs skip the respond-mode gate above and are instead gated only by `dmPolicy`/`dmAllowlist` (`inbound.ts:518-531`, default `'allowlist'` — `relay-adapter-schemas.ts:140`, `slack-adapter.ts:103`). Every allowlisted DM is answered regardless of @mention.

Slack's `app_mention` event is registered separately and forced to `'always'` since Slack already pre-filtered it — `slack-adapter.ts:164-181`.

### Telegram

**No gating predicate exists at all.** `bot.on('message', ...)` (`packages/relay/src/adapters/telegram/telegram-adapter.ts:320-328`) registers unconditionally, and `handleInboundMessage()` (`telegram/inbound.ts:111-194`) has no mention check, no respond-mode option, no per-chat allowlist — only early-returns for missing message/chat (line 121, 127) or empty text (line 136). `isGroupChat()` (`inbound.ts:81-83`) affects only the outgoing `channelType` label and subject encoding, never whether to respond.

Confirmed structurally: `TelegramAdapterConfigSchema` (`packages/shared/src/relay-adapter-schemas.ts:62-80`) has `token`, `mode`, `webhookUrl/Port/Secret`, `streaming`, `approverAllowlist` — no `respondMode`, `dmPolicy`, or mention field, unlike Slack's schema.

**Conclusion: Telegram answers every text message in every chat type (group, supergroup, private) identically. No @mention requirement in groups.** Group vs. DM only affects streaming mechanics (native draft streaming is DM-only, `outbound.ts:258`), not whether the agent responds.

---

## 2. Mention handling (Slack; Telegram has none)

**No stripping/translation of any mention.** `content = event.text.slice(0, MAX_CONTENT_LENGTH)` (`inbound.ts:554`) — raw Slack text passes through verbatim. `hasBotMention()` only detects presence via substring match; it never rewrites the text.

- The bot's own `<@BOTUSERID>` mention reaches the agent unmodified, inside `payload.content`.
- **Other participants' mentions are preserved identically** — nothing distinguishes or strips a `<@U456>` referencing someone else; it passes through the same as the bot's own mention token.

Sender resolution is separate machinery: `resolveUserName()` (`inbound.ts:320-342`) resolves only the _message author's_ Slack user ID to a display name for the `senderName` field — it does not touch mention tokens embedded in the body.

**Outbound — the agent never emits a Slack mention.** Full read of `outbound.ts`, `stream.ts`, `approval.ts`: agent-authored content only flows through `formatForPlatform(content, 'slack')` → `slackifyMarkdown()` (`outbound.ts:253`; `stream.ts:180,338,354,388,404,462,481`). No code path inserts `<@userId>` into agent-generated text. The only `<@userId>` emitted outbound is **system/glue code**, not agent output — the tool-approval decision notice built directly from the Slack button-click payload:

```ts
// slack-adapter.ts:390, 396
text: `${emoji} Tool ${decision} by <@${btnBody.user?.id ?? 'unknown'}>`,
text: `${emoji} *Tool ${decision}* by <@${btnBody.user?.id ?? 'unknown'}>`,
```

This mentions the _approver who clicked the button_, using the ID Slack already gave in the interaction payload — no name→ID resolution involved, and not something the agent chose to write.

`slack-platform-client.ts` (fully read) implements only `postMessage/editMessage/deleteMessage/startTyping/stopTyping/handleInbound(no-op)/destroy` — it contains **no** user resolution logic; that lives entirely in `inbound.ts`'s `resolveUserName`/`resolveChannelName` with TTL caches (`inbound.ts:210-226, 320-369`).

Telegram: no mention-parsing/stripping/translation code exists anywhere in `telegram/inbound.ts` or `telegram/outbound.ts` (confirmed by full read). Telegram outbound sends agent text as-is through Markdown→HTML conversion only.

---

## 3. Identity and multi-sender context

**Sender name is captured at inbound on both platforms**, matching `specs/channel-sender-identity` (manifest marks it `"status": "implemented"` — verified against code, not trusted from the spec text):

- Slack, `inbound.ts:590-598`:
  ```ts
  const senderName = event.user ? await resolveUserName(state, client, event.user) : 'unknown';
  const channelName = isGroup ? await resolveChannelName(state, client, event.channel) : undefined;
  const payload: StandardPayload = { content, senderName, channelName, channelType: isGroup ? 'group' : 'dm', ... };
  ```
  Resolution priority (`inbound.ts:331-336`): `user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || userId`.
- Telegram, `inbound.ts:143-151`:
  ```ts
  const senderName = from
    ? [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || UNKNOWN_SENDER
    : UNKNOWN_SENDER;
  const payload: StandardPayload = { content: text, senderName, channelName: isGroup ? extractChannelName(chat) : undefined, channelType: isGroup ? 'group' : 'dm', ... };
  ```

`StandardPayloadSchema` (`packages/shared/src/relay-envelope-schemas.ts:123-137`) formalizes `senderName`/`channelName` as the shared envelope contract both adapters populate.

**Where it's injected into the actual prompt** — not in slack/ or telegram/, but in the Claude Code runtime consumer, `packages/relay/src/adapters/claude-code/agent-handler.ts`. Extraction: `extractSenderIdentity()` (`packages/relay/src/lib/payload-utils.ts:99-119`), sanitized (`sanitizeIdentity`, `payload-utils.ts:74-83`, strips control chars and `<`/`>` to prevent identity-forged prompt injection). Injection, `agent-handler.ts:431-461` (`formatPromptWithContext`):

```ts
const lines = [
  `Agent-ID: ${agentId}`, `Session-ID: ${sdkSessionId}`, `From: ${envelope.from}`,
  ...(sender !== undefined ? [`Sender: ${sender}`] : []),
  ...(chat !== undefined ? [`Chat: ${chat}`] : []),
  `Message-ID: ${envelope.id}`, `Subject: ${envelope.subject}`, `Sent: ${envelope.createdAt}`, ...
];
return `<relay_context>\n${lines.join('\n')}\n</relay_context>\n\n${content}`;
```

So every inbound message the agent sees is prefixed with a `<relay_context>` block containing `Sender: <resolved display name>` (and `Chat:` for groups) — this is how the agent knows who said what in a multi-human channel.

Cross-adapter search (`senderName`/`sender`/`author`/`displayName`/`real_name`/`username`) found no `author`/`displayName` field anywhere in `packages/relay/src/adapters/`; Telegram also carries raw `fromId`/`username` in `platformData` (`inbound.ts:163-164`) alongside the constructed `senderName`.

**History hydration is explicitly absent.** Grep for `conversations.history|conversations.replies|getUpdates|\.history(` across `packages/relay/src` returned zero matches for any actual history-fetch API call.

- No `client.conversations.history(...)` / `client.conversations.replies(...)` call anywhere in the Slack adapter files. `ThreadParticipationTracker` (`slack/thread-tracker.ts`) tracks only a boolean "has the bot posted in this thread" via an in-memory `Map<string, number>` — never replays message content.
- The `channels:history` etc. strings in `slack/slack-manifest.ts:49,52,54,57,100,292` are OAuth **scopes** required to receive live events at all, not evidence of a history-fetch code path.
- No `getUpdates`-style backfill in any Telegram adapter file.
- `StandardPayloadSchema` has a single `content: z.string()` field, no `history`/`messages` array — the payload contract has no field for prior-turn content even if an adapter wanted to attach it.

**Conclusion: the agent only ever sees the single triggering message** (plus whatever conversation memory the Claude Code SDK session itself retains, which is a session-continuity mechanism separate from the relay/adapter layer). No channel- or thread-history hydration is performed by either adapter before dispatch.

---

## 4. Session mapping

**The relay subject/key is built from channel-id (or chat-id) alone — `thread_ts` and sender user-id never enter it.**

Slack, `inbound.ts:276-282`:

```ts
export function buildSubject(
  codec: SlackThreadIdCodec,
  channelId: string,
  isGroup: boolean
): string {
  return codec.encode(channelId, isGroup ? 'group' : 'dm');
}
```

called at `inbound.ts:551`: `buildSubject(resolvedCodec, event.channel, isGroup)`. `event.thread_ts` is captured into `platformData.threadTs` (`inbound.ts:610`) for reply-threading UI only — it never enters the subject.

Telegram, `inbound.ts:53-59`, identical pattern keyed on `chatId`. Grep for `message_thread_id`/`is_topic_message`/`topic` across the Telegram adapter dir: **zero hits** — Telegram forum "topics" are not read or handled anywhere.

Codec grammar (`packages/relay/src/lib/thread-id.ts:89-177`): subjects are exactly `relay.human.slack[.instanceId].<channelId>` (or `...group.<channelId>`) and the Telegram equivalent keyed on chat id. No thread/topic segment exists in either codec.

**Channel → DorkOS session**: `BindingRouter.resolveSession`, `apps/server/src/services/relay/binding-router.ts:386-409`:

```ts
switch (binding.sessionStrategy) {
  case 'stateless':
    return this.createNewSession(binding);
  case 'per-user': {
    const userId = (metadata as any)?.userId ?? chatId ?? 'unknown';
    return this.getOrCreateSession(`${binding.id}:user:${String(userId)}`, binding);
  }
  case 'per-chat':
  default:
    return this.getOrCreateSession(`${binding.id}:chat:${chatId ?? 'default'}`, binding);
}
```

`chatId` = the raw channel/chat id from the parsed subject — never `thread_ts`. `SessionStrategySchema` (`packages/shared/src/relay-adapter-schemas.ts:342-355`) is closed to `'per-chat' | 'per-user' | 'stateless'`, default `'per-chat'`. **There is no `'per-thread'` strategy.**

**Thread replies vs. top-level messages land on the identical subject** and therefore the identical session under `per-chat` (the default/realistic option). `thread_ts` affects only two things, neither of which is session identity: (1) whether the bot processes the message at all (the `thread-aware` respond-mode gate above), and (2) where the reply visually threads in Slack's UI (`resolveThreadTs()`, `outbound.ts:85-93`, used as the `thread_ts` param on `chat.postMessage`/`chat.update`).

`per-user` exists as a strategy but nothing in Slack/Telegram inbound.ts populates `envelope.metadata.userId` from `event.user`/`from.id` — the payload carries `senderName`/`platformData.userId`/`platformData.fromId` instead — so `per-user` effectively degrades to chat-id-keyed behavior as currently wired. `stateless` creates a brand-new session on every single inbound message regardless of thread (`binding-router.ts:392-393`).

Persistence: in-memory `Map<string,string>` (`binding-router.ts:107`) backed by `{relayDir}/sessions.json` (`:118, 516-531`), LRU-evicted at 10,000 entries (`:104, 452-461`).

---

## 5. Verbosity / event surface

**The research doc `research/20260317_relay_adapter_event_whitelist.md`'s claimed current-state `SILENT_EVENT_TYPES` blacklist does not exist in the code as read** — grep across `payload-utils.ts` and both adapters' `outbound.ts`: zero matches. A test comment confirms this is intentional: `telegram/__tests__/outbound.test.ts:32`: `// Mock payload-utils.js — mirrors actual implementations without SILENT_EVENT_TYPES`.

**Actual gate: an unnamed, hand-written if-chain per adapter ending in a silent drop**, not a single exported allowlist constant.

Slack, `outbound.ts:202-250`:

```ts
const eventType = detectStreamEventType(envelope.payload);
if (eventType) {
  const textChunk = extractTextDelta(envelope.payload);
  if (textChunk) { ... return handleTextDelta(...); }
  const errorMsg = extractErrorMessage(envelope.payload);
  if (errorMsg) { ... return handleError(errorMsg, ctx); }
  if (eventType === 'done') { ... return handleDone(ctx); }
  if (eventType === 'approval_required') { ... return handleApprovalRequired(...); }
  // All other StreamEvent types: silently drop (whitelist model)
  logger.debug(`deliver: dropping stream event '${eventType}' (whitelist)`);
  return { success: true, durationMs: Date.now() - startTime };
}
```

Telegram, `outbound.ts:246-334`: structurally identical, same four handled types, same drop-with-debug-log fallthrough (`:331-334`).

Of the **38** possible event types in `StreamEventTypeSchema` (`packages/shared/src/schemas.ts:39-79`), only **4 produce visible platform action**: `text_delta`, `error`, `done`, `approval_required`. The other 34 — including `thinking_delta`, `subagent_text_delta`, `tool_call_start/delta/end`, `tool_result`, `tool_progress`, `question_prompt` — are silently dropped. Confirmed by test: `telegram/__tests__/outbound.test.ts:734-756`, `describe('event whitelist — unknown events silently dropped')` parameterized over 21 event-type names.

Nothing upstream filters either — `publishResponseWithCorrelation()` (`packages/relay/src/adapters/claude-code/publish.ts:104-147`) forwards **every** SDK StreamEvent verbatim to the reply subject; the `STREAM_EVENT_TYPES` set in `agent-handler.ts:51-66` only prevents an infinite loop on inbound re-processing, it is not an outbound filter. All filtering burden sits in each channel adapter's `deliverMessage()`.

**Tool calls**: not represented as messages at all (all `tool_call_*`/`tool_result`/`tool_progress` silently dropped). The only tool-related surface is the `approval_required` interactive card (Slack: `approval.ts:88-159`; Telegram: `outbound.ts:486-595`), which fires only when the agent's permission mode requires human approval — routine (auto-approved) tool execution never appears on either platform.

**Thinking**: `thinking_delta` is unreferenced anywhere in either adapter's outbound code — dropped unconditionally, no summarization, no separate message.

**Subagent output**: `subagent_text_delta` has zero references anywhere in `packages/relay/src/adapters/` — not matched by `extractTextDelta()` (which only recognizes `type === 'text_delta'`), so it isn't merged into the streaming buffer either; it falls into the generic drop branch. No threading, no summarization — subagent/Task-tool runs are invisible on both platforms.

**Streaming delivery mechanics**:

Slack — three modes via `streaming`/`nativeStreaming` config (default both `true`, `slack-adapter.ts:271-273`):

1. Native streaming (default, requires a thread): `chat.startStream` → `chat.appendStream` per flushed chunk → `chat.stopStream` (`stream.ts:367-397, 326-342, 561-605`).
2. Legacy edit-in-place (`nativeStreaming:false` or no thread): one `chat.postMessage`, then throttled `chat.update` at ≥1000ms (`STREAM_UPDATE_INTERVAL_MS`, `stream.ts:32, 344-364`), finalized in `finalizeStreamText()` (`stream.ts:501-551`).
3. Buffered (`streaming:false`): accumulate silently, post once on `done`.

Overflow beyond 3500 chars (`SLACK_MAX_LENGTH`, `payload-utils.ts:309`) posts additional paced follow-up messages in-thread (`SLACK_CHUNK_PACING_MS=1100`, `stream.ts:36, 533-548`).

Typing indicator: emoji-reaction only, **default is `'none'`** — `slack-adapter.ts:157,176,273`: `this.config.typingIndicator ?? 'none'` — this contradicts the app manifest's own description text, `slack-manifest.ts:190`: "Show a visual indicator while the agent is working. Enabled by default." (code-vs-copy mismatch).

Telegram — no message-edit analog:

- DMs only (`chatId > 0`) with `streaming:true` (default): unofficial `sendMessageDraft`, throttled ≥200ms (`DRAFT_UPDATE_INTERVAL_MS`, `outbound.ts:43, 258-272`); draft failures fall back silently to buffer-and-flush.
- Groups (`chatId < 0`) or `streaming:false`: pure buffer-and-flush, one `sendMessage` on `done` (`outbound.ts:246-301`).
- Typing indicator: native `sendChatAction('typing')`, refreshed every 4s, capped at 60s (`outbound.ts:355-464`) — unconditional, no config toggle (unlike Slack's opt-in-but-defaulted-off reaction).

Both platforms split long standard (non-stream) payloads at platform max length (3500/4000 chars) into separate messages (`payload-utils.ts:302-424`; `slack/outbound.ts:252-284`; `telegram/outbound.ts:337-340`).

---

## 6. Concurrency and turn-taking

**No queue, debounce, or lock exists inside the Slack/Telegram adapter files themselves.** Every accepted inbound message is published to the relay bus unconditionally, with no check for an in-flight turn on that subject:

- Slack: `inbound.ts:615-619`, unconditional `relay.publish(subject, payload, ...)`.
- Telegram: `inbound.ts:168-172`, same pattern.
- `base-adapter.ts:67-116`'s only guard (`_startPromise`, line 74) serializes concurrent `start()` calls on the adapter connection itself, not per-message/per-turn.
- `delivery-pipeline.ts` has a 5-second dispatch-dedup set (`recentlyDispatched`, `:68, 221-227`) to stop the same Maildir file firing twice — this is file-event dedup, not turn serialization; a genuinely distinct second message is delivered immediately.
- `adapter-delivery.ts:97-133` explicitly documents `relay.agent.*` deliveries as **detached**: `deliverDetached()` (`:143-170`) fires the agent turn in the background and returns success immediately (`:6-11`, doc comment: _"an agent turn can run far longer than any reasonable publish timeout... Publish therefore acknowledges acceptance immediately and the turn runs in the background."_). Nothing here blocks a second detached delivery from starting concurrently.

**The real serialization lives one layer deeper**, in the agent-runtime adapter, not the channel adapters:

- `packages/relay/src/adapters/runtime-adapter.ts:135-136`: `private readonly sessionQueues = new Map<string, Promise<void>>();` — per-session promise chains.
- `:147-165` doc: _"Runs inside the per-session serial queue so concurrent calls for the same sessionId execute one at a time... Calls for different sessions run in parallel."_
- `claude-code-adapter.ts:264-271`: queue key = `extractSessionIdFromSubject(subject) ?? subject`.
- Test-verified: `packages/relay/src/adapters/__tests__/runtime-adapter.test.ts:228-253` (same-session peak concurrency = 1) and `:255-277` (different-session peak concurrency > 1).

**Bottom line**: a second message on the same Slack channel/thread or Telegram chat while the agent is mid-turn is **queued and runs serially after the current turn** — but that queueing is a property of the Claude Code runtime adapter (keyed by session id), not of the Slack/Telegram adapters or the generic relay delivery pipeline. From the channel adapter's point of view there is no lock or reject; a burst of N messages to the same session all get accepted and dispatched, and correctness depends entirely on the downstream session queue existing and being correctly keyed.

Secondary risk: Slack's outbound stream buffer is keyed by `channelId:streamKeyTs` (`stream.ts:129-130`). Two turns streaming concurrently into the _same_ key (no `threadTs`, same correlation) could collide/overwrite `ActiveStream` entries in the shared map — the only test covering this (`slack/__tests__/outbound.test.ts:764-790`) proves isolation only when the key _differs_ (different `envelope.from`), not that same-key concurrency is otherwise guarded.

---

## 7. Loop prevention / multi-bot safety

### Slack — explicit guard, three layers

`inbound.ts:478-482` (self-echo):

```ts
// Skip bot's own messages (echo prevention)
if (event.user === botUserId) {
  logger.debug(`inbound skipped: echo (own user ${botUserId})`);
  return;
}
```

`inbound.ts:484-488` (any bot, blanket):

```ts
// Skip bot messages and non-user subtypes
if (event.bot_id) {
  logger.debug(`inbound skipped: bot message (bot_id=${event.bot_id})`);
  return;
}
```

`inbound.ts:41-59, 489-492`: `SKIP_SUBTYPES` includes `'bot_message'` (plus `message_changed`/`message_deleted` etc.) as a second layer.

Together: any event carrying `bot_id`, `subtype:'bot_message'`, or `user === botUserId` is dropped before `relay.publish` — a second bot in the same Slack channel cannot trigger a loop.

### Telegram — **no such guard exists. Stated explicitly: this is a real gap.**

- `telegram/inbound.ts`: grep for `is_bot`, `from.is_bot`, `bot_id` — **zero matches**. `handleInboundMessage()` (`:111-194`) checks only message/chat presence and non-empty text.
- `telegram/telegram-adapter.ts`: same grep, zero matches. `wireBot()` (`:318-332`) registers `bot.on('message', ...)` with no bot-filter applied.
- `telegram/webhook.ts`: no `is_bot`/`bot_id` handling (full read) — only secret-token verification and HTTP lifecycle.
- The only bot-adjacent guard on Telegram is a _different_ mechanism — self-echo on the outbound side: `telegram/outbound.ts:198-203`, `if (envelope.from.startsWith(codec.prefix)) { ...skip self-originated... }` — this stops the adapter re-delivering its own reply outward; it does **not** filter inbound updates from another Telegram bot in a group.
- No test in `telegram/__tests__/` exercises an `is_bot`/`from.is_bot` scenario (grep: zero matches).

**If DorkOS's Telegram bot shares a group with another bot** (and Telegram's group privacy-mode settings let each bot see the other's messages — an external, operator-configured mitigating factor, not anything enforced by this codebase), **there is no code-level guard preventing the agent from treating the other bot's message as a human message and replying to it.** This is the single starkest asymmetry between the two adapters found in this audit.

---

## 8. Tool approval in chat

### Slack — Block Kit interactive buttons

`approval.ts:88-159` (`handleApprovalRequired`) posts an `actions` block:

```ts
{
  type: 'actions', block_id: 'tool_approval',
  elements: [
    { type: 'button', text: {type:'plain_text', text:'Approve'}, style:'primary', action_id:'tool_approve', value: buttonValue },
    { type: 'button', text: {type:'plain_text', text:'Deny'},    style:'danger',  action_id:'tool_deny',    value: buttonValue },
  ],
}
```

`buttonValue` encodes only `{toolCallId, sessionId, agentId}` (`:104-108`) — no tool parameters leaked into the button payload.

Handlers registered `slack-adapter.ts:181-188` (`tool_approve`/`tool_deny` actions → `handleToolAction`). `handleToolAction` (`:314-410`) checks the approver allowlist (`mayApprove`, `:359`), publishes `approval_response` to `relay.system.approval.${agentId}` (`:376-388`), and updates the original message via `chat.update` to remove the buttons (`:390-401`). A timeout auto-updates the card to "Timed Out" if nobody responds (`approval.ts:166-196`). No plain-text-reply or emoji-reaction approval path exists (grepped both files).

### Telegram — has an equivalent (inline keyboard)

`telegram-adapter.ts:329-330` registers `bot.on('callback_query:data', ... this.handleApprovalCallback ...)`. `handleApprovalCallback` (`:341-405`) parses `{k,a}` from callback data, looks it up in `outboundState.callbackIdMap`, checks the same `mayApprove()` allowlist (`:359`), publishes `approval_response` to `relay.system.approval.${agentId}` (`:376-388`), edits the message via `ctx.editMessageText(...)` (`:394`).

### Discrepancies vs. `research/20260317_slack_tool_approval_block_kit.md`

1. **No local `pendingApprovals` resolve/reject Map** as the research proposed (its "Option C"). The shipped design routes through a full relay round-trip (`relay.system.approval.*`), i.e. the research's "Option A," not its recommendation.
2. **Slack's handler is not idempotent against double-click / duplicate delivery** — `handleToolAction` never checks whether a `toolCallId` was already resolved before re-publishing `approval_response`; a double-click could double-publish. **Telegram's handler, by contrast, is idempotent**: it checks `callbackIdMap.get(data.k)` and replies "This approval has expired" if absent, deleting the entry on first use (`telegram-adapter.ts:347-352, 372`). No Slack test exercises this race (grep for "already resolved"/"duplicate"/"double": none found for Slack).
3. **No confirm dialog, no visible countdown** in the Slack card (research proposed both); the timeout is enforced server-side (`setTimeout`) but not surfaced in the card until it fires.
4. **Authorization model differs from the research's "Option B" (restrict to original requester)**: the shipped code uses an operator-configured approver **allowlist** (`mayApprove()`, `approver-allowlist.ts:75-80`) — any allowlisted user may approve/deny, not necessarily the person who triggered the turn. Documented as a deliberate fix for DOR-609 ("the triggering user could otherwise approve their own request") in `approver-allowlist.ts:1-40`.
5. **Manifest claim is stale**: the research doc claims `interactivity: {is_enabled: true}` is missing from the Slack app manifest; it is already present, `slack-manifest.ts:69-70`. The manifest also now lives in its own `slack-manifest.ts` file, not inline in `slack-adapter.ts` as the doc describes.

---

## 9. Known bugs / limits

**No TODO/FIXME/HACK comments exist anywhere in the Slack or Telegram adapter source** (`grep -n "TODO\|FIXME\|HACK" packages/relay/src/adapters/{slack,telegram}/*.ts` → zero matches). The adapters carry no in-code admissions of unfinished work via these markers — itself notable given the scope of the multi-participant questions this audit raises.

Test-file admissions of edge-case handling (none explicitly framed as "unhandled," but instructive):

- `slack/__tests__/outbound.test.ts:763-790` — `'concurrent responses from different agents get independent stream state'`: only proves isolation when the stream key _differs_; the same-key collision case (two turns replying into one thread with no distinguishing correlation id) is untested.
- `slack/__tests__/outbound.test.ts:726` — stale/orphaned agent streams (no `done`/`error` ever received) are cleaned up only reactively, on the _next_ `deliverMessage()` call for that adapter instance — a truly abandoned stream with no further Slack traffic can linger indefinitely.
- `telegram/__tests__/outbound.test.ts:342` — `'orphan timeout does not clear a newer typing session for the same chat'`: documents a specific race between an expiring and a fresh typing-indicator timeout for the same chat.
- `telegram/__tests__/outbound.test.ts:885` — `'silently swallows sendMessageDraft errors (graceful fallback)'`.
- `telegram/__tests__/outbound.test.ts:802` — confirms native streaming is deliberately disabled for Telegram groups (buffer-and-flush only), matching the doc comment `telegram-adapter.ts:142-144`.
- `slack/__tests__/inbound.test.ts:543-566` — the Slack event-dedup TTL cache (5 min) allows a very-delayed Slack retry (same `event_id`, past the TTL) to be reprocessed as new — an intentional but bug-adjacent tradeoff.
- `slack/__tests__/slack-adapter.test.ts:198` — comment: "Suppress the expected unhandled rejection from the timeout race under fake timers" — a test-harness artifact, not a production bug, but names a race explicitly.
- `packages/relay/src/adapters/__tests__/runtime-adapter.test.ts:228-277` — the only tests in the whole package directly asserting same-session serialization vs. cross-session parallelism; no equivalent test exists asserting Slack/Telegram _inbound_ handling serializes anything, because per §6 it doesn't — serialization is one layer down.

**No test or comment anywhere in either adapter's `__tests__/` tree contains phrases like "doesn't handle multiple users" or "not supported yet."** That class of caveat is entirely absent — which is itself a gap: multi-human-participant group-chat scenarios are exercised only indirectly (stream-isolation and session-queue tests), never called out as a known limitation in code or comments.

---

## Cross-cutting note: Slack vs. Telegram maturity gap

Slack is the "reference" implementation: respond-mode gating (3 modes + per-channel override + DM allowlist), bot-loop guard (3 layers), thread participation tracking, native streaming, Block Kit approval UX. Telegram implements session mapping, identity capture, streaming/typing, and approval UX to a comparable standard, but is missing two things Slack has: (1) any trigger/response gating (Telegram always responds), and (2) any bot-loop guard (Telegram has zero `is_bot` filtering). Telegram's approval handler is more robust than Slack's in one respect (idempotent against duplicate callback delivery; Slack's is not).
