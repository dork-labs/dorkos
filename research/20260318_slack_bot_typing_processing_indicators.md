---
title: 'Slack Bot Typing & Processing Indicators — Comprehensive API Reference'
date: 2026-03-18
type: external-best-practices
status: active
tags:
  [
    slack,
    bot,
    typing-indicator,
    reactions,
    processing-indicator,
    assistant-threads,
    rate-limits,
    bolt,
  ]
feature_slug: relay-external-adapters
searches_performed: 6
sources_count: 14
---

# Slack Bot Typing & Processing Indicators

**Research Date:** 2026-03-18
**Research Mode:** Focused Investigation
**Context:** Understanding how a DorkOS Slack bot adapter can signal to a user that it is actively processing their request, covering all available mechanisms, rate limits, and best practices as of early 2026.
**Prior research incorporated:** `20260313_slack_bot_adapter_best_practices.md`

---

## Research Summary

Slack does not have a generic "bot is typing..." API equivalent to Telegram's `sendChatAction`. The old RTM-based typing indicator was part of the deprecated legacy RTM API (shut down September 2024) and is gone. There are now three viable options in 2026 for indicating a bot is working: (1) **`assistant.threads.setStatus`** — a proper typing-indicator-style API, but only works in the Slack "AI agent" thread view which imposes a specific UX mode; (2) **`reactions.add`/`reactions.remove`** — add an hourglass emoji to the user's message while processing, remove it when done; (3) **`chat.startStream`** — the native streaming API creates a live typing animation in Slack UI automatically. For DorkOS's use case (regular DM or channel conversation, not the AI assistant panel), reactions are the pragmatic workaround and streaming is the best full solution.

---

## Key Findings

### 1. No Generic Bot Typing Indicator Exists in 2026

There is no `sendTypingAction` equivalent in the Slack Web API or Events API for bots operating in normal channels/DMs.

- The `user_typing` event is **receive-only** — apps can listen for it but cannot broadcast it as a bot
- The legacy RTM API's `typing` message type (which could send this) is **permanently deprecated** — Slack shut down RTM support for custom bots and classic apps in September 2024
- Two active GitHub issues (#885, #2580 on `slackapi/bolt-js`) track this as a popular feature request. Issue #2580 was closed in June 2025 as a duplicate of #885, with the Slack team noting "no immediate plans to share." This is a **known API gap with no announced timeline to fill**.

### 2. `assistant.threads.setStatus` — Proper Typing Indicator, But Constrained

Slack has a first-party status API designed specifically for AI agents: **`assistant.threads.setStatus`**.

**What it does:**

- Renders as `<Bot Name> <status>` below the message composer in Slack's UI
- Example: `"DorkOS is thinking..."` displayed live to the user
- Supports up to 10 rotating status messages (`loading_messages` parameter)
- Auto-clears after 2 minutes if no message is sent

**The constraint:** This API only works in Slack's **AI Assistant thread view** — the dedicated split-panel UI mode that Slack added for AI agent apps. Activating it requires the `assistant:write` scope (transitioning to `chat:write` only — see scope changes below) AND the "Agents & AI Apps" feature enabled in the Slack workspace.

**Scope changes (March 2026):** Slack announced on 2026-03-05 that `assistant.threads.setStatus` now accepts either `assistant:write` OR `chat:write`. They are phasing out the `assistant:write` requirement. No deadline announced, but developers should migrate to `chat:write` soon.

**Rate limit:** 600 requests per minute per app per team (custom overrides available).

**Bottom line for DorkOS:** Using this API forces the conversation into Slack's AI assistant panel UX. If DorkOS wants to remain in a normal DM/channel thread conversation, this API does not apply. Reserve this for a potential future "Slack AI Agent mode."

### 3. `reactions.add` / `reactions.remove` — Best Pragmatic Workaround

The established community pattern for indicating bot processing in a standard Slack channel or DM:

1. When user message arrives: call `reactions.add` with `hourglass_flowing_sand` (or `thinking_face`, `gear`) on the user's message `ts`
2. When response is ready (or error occurs): call `reactions.remove` to remove the emoji

**This is the closest thing to a typing indicator in normal Slack bot interactions.**

**Rate limits (confirmed from docs.slack.dev as of 2026-03-18):**

| Method             | Tier       | Limit                   |
| ------------------ | ---------- | ----------------------- |
| `reactions.add`    | **Tier 3** | 50+ requests per minute |
| `reactions.remove` | **Tier 2** | 20+ requests per minute |

**Required scope:** `reactions:write` (both add and remove use the same scope)

**Required parameters for `reactions.add`:**

```typescript
await client.reactions.add({
  channel: event.channel, // C1234567890 or D1234567890
  name: 'hourglass_flowing_sand', // emoji shortcode, no colons
  timestamp: event.ts, // ts of the message to react to
});
```

**Required parameters for `reactions.remove`:**

```typescript
await client.reactions.remove({
  channel: event.channel,
  name: 'hourglass_flowing_sand',
  timestamp: event.ts,
});
```

**Scope addition needed:** Add `reactions:write` to the bot token scopes in the Slack app settings.

**Error handling:** The bot must be a member of the channel or the call returns `not_in_channel`. In DMs (channel type `im`), the bot is implicitly a member so this is not an issue. Always wrap in try/catch — reactions are best-effort UI polish, not critical path.

**Rate limit safety:** At 50+/min for add and 20+/min for remove, a single-user bot will never hit this limit in normal usage. DorkOS is single-tenant; this is not a concern.

### 4. Native Streaming API — Best Full Solution

`chat.startStream` / `chat.appendStream` / `chat.stopStream` (released October 2025) provide the best overall UX: Slack renders a live typing animation in the message itself while chunks arrive. This inherently communicates "bot is working" without any extra API call.

For full details see `20260313_slack_bot_adapter_best_practices.md` Section 6. Key point: when using `client.chatStream()`, the typing indicator problem is solved automatically.

---

## Recommended Approach for DorkOS

Given DorkOS operates in standard DM/channel threads (not the AI assistant panel), the recommended strategy is:

### Option A: Streaming API (Best UX)

Use `client.chatStream()` — the typing animation is native. No extra scopes or API calls needed.

```typescript
const stream = await client.chatStream({
  channel: event.channel,
  thread_ts: event.ts,
});
// Slack shows typing animation automatically while stream is open
for await (const chunk of agentResponseStream) {
  await stream.append(chunk.text);
}
await stream.stop();
```

### Option B: Reaction Indicator (Best Fallback)

Use `reactions.add` immediately on receipt, remove after response is posted. Graceful failure is acceptable.

```typescript
async function withProcessingIndicator<T>(
  client: WebClient,
  channel: string,
  messageTs: string,
  work: () => Promise<T>
): Promise<T> {
  const emoji = 'hourglass_flowing_sand';

  // Best-effort: add reaction, don't throw if it fails
  try {
    await client.reactions.add({ channel, name: emoji, timestamp: messageTs });
  } catch {
    // Not in channel, already reacted, etc. — continue
  }

  try {
    return await work();
  } finally {
    // Always remove, even on error
    try {
      await client.reactions.remove({ channel, name: emoji, timestamp: messageTs });
    } catch {
      // Ignore — reaction may already be gone
    }
  }
}
```

### Option C: Immediate Acknowledgment Message (Simplest)

Post `_Processing..._` immediately in thread, then update or send a follow-up. Already documented in prior research.

### Recommended Combination for DorkOS

- **Primary:** Use `chatStream()` for the response — the typing animation is implicit
- **Secondary (pre-stream acknowledgment):** Add `hourglass_flowing_sand` reaction immediately on message receipt, before the stream starts. Remove it when `stream.stop()` completes.
- This gives users two feedback signals: an instant reaction (sub-second) + the live streaming text

---

## Scope Checklist Update

Add `reactions:write` to the bot scopes documented in `20260313_slack_bot_adapter_best_practices.md` Section 3:

```
reactions:write    Add/remove emoji reactions to messages (for processing indicators)
```

---

## API Reference Summary

| Method                        | Purpose                                         | Rate Limit       | Scope                                |
| ----------------------------- | ----------------------------------------------- | ---------------- | ------------------------------------ |
| `reactions.add`               | Add emoji to user message while processing      | Tier 3 (50+/min) | `reactions:write`                    |
| `reactions.remove`            | Remove emoji when done                          | Tier 2 (20+/min) | `reactions:write`                    |
| `assistant.threads.setStatus` | Typing indicator in AI assistant panel only     | 600/min          | `chat:write` (was `assistant:write`) |
| `chat.startStream`            | Native streaming with implicit typing animation | Not published    | `chat:write`                         |
| `user_typing` (RTM)           | **Deprecated — do not use**                     | N/A              | N/A                                  |

---

## Sources

- [reactions.add method | Slack Developer Docs](https://docs.slack.dev/reference/methods/reactions.add/)
- [reactions.remove method | Slack Developer Docs](https://docs.slack.dev/reference/methods/reactions.remove/)
- [assistant.threads.setStatus method | Slack Developer Docs](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/)
- [Set status method scope update | Slack Developer Docs](https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/)
- [Rate limits | Slack Developer Docs](https://docs.slack.dev/apis/web-api/rate-limits/)
- [Rate limit changes for non-Marketplace apps | Slack Developer Docs](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
- [user_typing event | Slack Developer Docs](https://docs.slack.dev/reference/events/user_typing/)
- [Is it possible to indicate "Bot user typing..." using bolt-js — Issue #885](https://github.com/slackapi/bolt-js/issues/885)
- [Bot user is typing API — Issue #2580 (closed as duplicate)](https://github.com/slackapi/bolt-js/issues/2580)
- [New features for Slack apps sending AI responses (chat streaming) | Slack Developer Docs](https://docs.slack.dev/changelog/2025/10/7/chat-streaming/)
- [Prior research: Slack Bot Adapter Best Practices](research/20260313_slack_bot_adapter_best_practices.md)
