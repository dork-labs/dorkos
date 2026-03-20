---
title: 'Slack Bot Adapter — Best Practices for DorkOS Relay'
date: 2026-03-13
type: external-best-practices
status: active
tags:
  [slack, bolt, adapter, relay, socket-mode, threading, streaming, mrkdwn, rate-limits, typescript]
feature_slug: relay-external-adapters
searches_performed: 8
sources_count: 28
---

# Slack Bot Adapter — Best Practices for DorkOS Relay

**Research Date:** 2026-03-13
**Research Mode:** Deep Research
**Context:** Building a Slack adapter for DorkOS Relay alongside the existing Telegram/grammY adapter.
**Prior research incorporated:** `20260227_slack_vs_telegram_relay_adapter.md`, `20260224_relay_external_adapters.md`, `20260228_adapter_agent_routing.md`

---

## Research Summary

The Slack bot ecosystem in 2026 is substantially more mature than when the initial Telegram comparison was written. The most important new development is Slack's native **chat streaming API** (released October 2025) — `chat.startStream`, `chat.appendStream`, `chat.stopStream` — which perfectly matches the DorkOS relay use case of streaming AI agent responses into Slack channels. For a self-hosted, single-tenant DorkOS deployment, **Socket Mode** remains the right choice: it eliminates the public URL requirement, is explicitly recommended by Slack for internal/behind-firewall deployments, and `@slack/bolt` v4+ handles reconnection transparently. The `@slack/bolt` SDK is the correct and only serious TypeScript option. For Markdown conversion, `slackify-markdown` (179K weekly downloads, v5.0.0 as of November 2025) is the clear winner.

---

## Key Findings

### 1. Socket Mode is the Correct Choice for DorkOS

**Recommendation: Socket Mode with `@slack/bolt`.**

- Slack now explicitly recommends Socket Mode for apps that "can't expose a public HTTP endpoint" — including self-hosted, behind-firewall, and single-tenant tools
- For DorkOS, Socket Mode eliminates the ngrok dependency that would otherwise be required for local development AND for self-hosted production installs
- RTM (Real Time Messaging API) is **fully deprecated** — Slack has discontinued it as of September 2024 alongside legacy custom bots and classic apps
- The 10-connection cap for Socket Mode is not a constraint for a single-tenant bot
- Socket Mode's primary production weakness (WebSocket drops with missed events) is not a concern for DorkOS: messages are agent-to-human notifications, not mission-critical financial transactions

**When to use HTTP Events API instead:**

- Distributing the bot as a Slack Marketplace app (Socket Mode is prohibited)
- Deploying behind a load balancer with multiple server instances
- When sub-second reconnection gaps would lose critical message context

**Verdict:** For DorkOS's self-hosted, single-tenant, local-first architecture, Socket Mode wins on every dimension that matters.

### 2. SDK: Use `@slack/bolt` Only

**Use `@slack/bolt` v4.x.** Do not mix in lower-level packages separately.

`@slack/bolt` wraps:

- `@slack/web-api` — all REST API calls
- `@slack/socket-mode` — WebSocket connection management
- `@slack/events-api` — signature verification (for HTTP mode)
- OAuth flows, interactive components, modals, slash commands

TypeScript support is good (not grammY-excellent, but production-quality). The package is maintained by Slack's developer relations team and is the single canonical SDK — there is no credible alternative.

```bash
npm install @slack/bolt
```

Bundle size: `@slack/bolt` is ~500KB (not ESM-treeshaken). For a server-side adapter in DorkOS's Express monorepo, this is irrelevant.

### 3. Required OAuth Scopes

**Bot Token Scopes (minimum for bidirectional relay):**

```
channels:history      Read messages in public channels the bot is in
channels:read         List channels (for channel discovery/validation)
chat:write            Send messages to channels the bot is in
chat:write.public     Send to public channels WITHOUT joining them first
im:history            Read direct messages sent to the bot
im:write              Open DM conversations (needed for conversations.open)
app_mentions:read     Receive @mentions in channels
groups:history        Read messages in private channels the bot is in
groups:read           List private channels (optional, for group DM support)
```

**Event Subscriptions (Bot Events):**

```
message.channels      Messages posted in public channels bot is in
message.im            Direct messages to the bot
app_mention           When the bot is @-mentioned in any channel
message.groups        Messages in private channels (if private channel support needed)
```

**App-Level Token (Socket Mode only):**

An additional `xapp-...` token with `connections:write` scope is required for Socket Mode. This is a third credential beyond `SLACK_BOT_TOKEN` (`xoxb-...`) and `SLACK_SIGNING_SECRET`.

```
Required env vars for Socket Mode:
  SLACK_BOT_TOKEN       xoxb-...  (bot token from OAuth & Permissions)
  SLACK_SIGNING_SECRET  hex       (from Basic Information → App Credentials)
  SLACK_APP_TOKEN       xapp-...  (from Basic Information → App-Level Tokens, connections:write)
```

**Note:** `SLACK_SIGNING_SECRET` is still required even in Socket Mode (Bolt validates it internally for consistency). The `xapp-...` token is the actual Socket Mode authentication mechanism.

### 4. Message Formatting — mrkdwn and the Streaming API

#### Standard mrkdwn (for non-streaming messages)

Slack uses `mrkdwn` — a non-standard Markdown dialect:

| Format          | Standard Markdown | Slack mrkdwn   |
| --------------- | ----------------- | -------------- |
| Bold            | `**text**`        | `*text*`       |
| Italic          | `_text_`          | `_text_`       |
| Strikethrough   | `~~text~~`        | `~text~`       |
| Inline code     | `` `code` ``      | `` `code` ``   |
| Code block      | ` ```code``` `    | ` ```code``` ` |
| Link            | `[text](url)`     | `<url\|text>`  |
| User mention    | N/A               | `<@U123456>`   |
| Channel mention | N/A               | `<#C123456>`   |

AI model responses use standard Markdown. Convert with **`slackify-markdown`**:

```bash
npm install slackify-markdown
```

```typescript
import slackifyMarkdown from 'slackify-markdown';

const slackText = slackifyMarkdown(markdownFromAgent);
await client.chat.postMessage({ channel, text: slackText });
```

`slackify-markdown` v5.0.0 (released November 2025, 179K weekly downloads, ~60 npm dependents) is the current best option. It is based on `unified`/`remark` and handles all standard Markdown constructs including tables, nested lists, and fenced code blocks.

**Message length limits:**

- `text` field: 4,000 characters (hard limit for `chat.postMessage`)
- Messages are truncated at 40,000 characters total
- For long AI responses: chunk at ~3,500 characters on paragraph boundaries and send as sequential messages (or use the streaming API)

#### Block Kit (for rich structured messages)

Block Kit is preferred when:

- Sending structured agent status updates (plan steps, task lists)
- Rendering agent responses with action buttons (approve, reject, etc.)
- Adding feedback buttons to AI responses (new in October 2025)

The `text` field should always be populated as a fallback for notifications:

```typescript
await client.chat.postMessage({
  channel,
  text: 'Agent response (fallback)', // Always include for notifications
  blocks: [
    {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: 'Agent response' }],
        },
      ],
    },
  ],
});
```

### 5. Threading Model

Slack's threading is `ts`-based. The `ts` field (Unix timestamp string like `"1704067200.000100"`) serves as both message ID and thread anchor.

**To reply in a thread:**

```typescript
await client.chat.postMessage({
  channel: event.channel,
  thread_ts: event.ts, // thread_ts = ts of the parent message
  text: 'Reply in thread',
});
```

**Recommended pattern for DorkOS relay:** Always reply in threads.

Rationale: Agent responses can be long and multi-part. Threads keep channel noise down and provide a natural conversation grouping. In Slack, threads are first-class — users see the reply count and can expand the thread without it cluttering the main channel.

Implementation in Bolt's `say()`:

```typescript
app.message(async ({ message, say }) => {
  if (message.subtype) return; // ignore edits, deletions, etc.

  await say({
    text: 'Processing...',
    thread_ts: message.ts, // reply in thread
  });
});
```

**Thread reply chains:** Once you start a thread (using `message.ts` as `thread_ts`), all subsequent replies to that conversation should use the _same_ original `thread_ts`, not the `ts` of intermediate replies. This keeps all agent turns in one thread.

```typescript
// Session key for per-conversation state:
const sessionKey = `${channel}:${thread_ts ?? message_ts}`;
```

### 6. Streaming AI Responses — The Native Streaming API (October 2025)

Slack released a native streaming API in October 2025 specifically for AI agent use cases. This is the correct pattern for DorkOS's streaming agent responses.

**Three methods:**

- `chat.startStream` — creates a streaming message placeholder in Slack
- `chat.appendStream` — appends a chunk of text to the in-progress stream
- `chat.stopStream` — closes the stream, optionally attaching Block Kit blocks (e.g., feedback buttons)

**Node.js SDK helper (`chatStream`):**

The `@slack/web-api` package (included in Bolt) provides a `client.chatStream()` helper that wraps all three calls:

```typescript
import { App } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

app.message(async ({ message, client }) => {
  if (message.subtype) return;

  // Start a streaming message in a thread
  const stream = await client.chatStream({
    channel: message.channel,
    thread_ts: message.ts, // reply in thread
    // recipient_user_id: message.user,  // optional: direct the stream to a specific user
  });

  // Consume the AI agent's async response stream
  for await (const chunk of agentResponseStream) {
    await stream.append(chunk.text);
  }

  // Stop the stream, optionally with feedback/action blocks
  await stream.stop({
    blocks: [
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Run again' },
            action_id: 'run_again',
          },
        ],
      },
    ],
  });
});
```

**Fallback: `chat.update` edit-in-place pattern** (for older Slack clients or when streaming API unavailable):

```typescript
// 1. Post initial "thinking" message
const { ts: botMsgTs } = await client.chat.postMessage({
  channel,
  thread_ts: event.ts,
  text: '_Agent is thinking..._',
  mrkdwn: true,
});

// 2. Accumulate chunks, update every N characters or T milliseconds
let accumulated = '';
let lastUpdateAt = Date.now();

for await (const chunk of agentStream) {
  accumulated += chunk.text;
  if (Date.now() - lastUpdateAt > 1000) {
    // throttle: max 1 update/second
    await client.chat.update({
      channel,
      ts: botMsgTs,
      text: slackifyMarkdown(accumulated) + ' ▌', // cursor indicator
    });
    lastUpdateAt = Date.now();
  }
}

// 3. Final update without cursor
await client.chat.update({
  channel,
  ts: botMsgTs,
  text: slackifyMarkdown(accumulated),
});
```

**Recommendation:** Use the native streaming API (`chatStream`) — it is purpose-built for this use case, provides better UX (Slack handles the progressive rendering), and avoids the chat.update rate-limit problem (each `chat.update` counts against the standard API tier).

### 7. Rate Limits and Best Practices

**Sending messages (`chat.postMessage`):**

- Tier: Special
- Limit: 1 message/second per channel
- Workspace-level burst cap applies (hundreds per minute)

**Streaming API methods (`chat.appendStream`):**

- Not subject to the same 1/sec per channel limit as `postMessage`
- Designed for high-frequency chunk delivery — throttle to reasonable human reading speed (~50ms between chunks)

**Read methods (for non-Marketplace, internal apps — exempt from May 2025 restrictions):**

- `conversations.history`, `conversations.replies`: Standard tier limits apply (not the 1 request/minute restriction that affects commercial non-Marketplace apps)
- Internal apps installed to a single workspace you own are **exempt** from the May 2025 rate limit tightening

**Handling 429 responses:**

```typescript
// @slack/bolt handles 429 automatically with Retry-After header
// For custom retry logic:
async function postWithRetry(client, params, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await client.chat.postMessage(params);
    } catch (err) {
      if (err.code === 'slack_webapi_rate_limited') {
        const retryAfter = err.retryAfter ?? 1;
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw err;
    }
  }
}
```

**Bolt's built-in retry:** Bolt's `WebClient` automatically retries on 429 responses using the `Retry-After` header. No manual retry logic is needed for standard use.

**Chunking long messages:**

If not using the streaming API, chunk long responses at paragraph boundaries:

```typescript
function chunkMarkdown(text: string, maxChars = 3500): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current = '';
  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > maxChars) {
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}
```

### 8. Security Considerations

#### Socket Mode Security Model

Socket Mode uses a long-lived WebSocket connection authenticated with the `xapp-...` app-level token. Security properties:

- No inbound HTTP endpoint exposed — no SSRF attack surface
- No need for HMAC signature verification (no webhook payloads)
- The WebSocket connection is initiated by your server to Slack's infrastructure (outbound only)
- The `SLACK_APP_TOKEN` must be stored securely; it is the only credential needed to establish the WebSocket

The tradeoff vs. HTTP mode: no signature verification means if the WebSocket is somehow hijacked, there is no secondary authentication layer. In practice, the WebSocket is TLS-encrypted and the `xapp-...` token must be rotated if compromised.

#### HTTP Events API Security (for future reference if switching modes)

If switching to HTTP mode, Bolt handles HMAC-SHA256 signature verification automatically:

```typescript
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // Bolt automatically verifies X-Slack-Signature on every request
});
```

Bolt verifies:

1. `X-Slack-Signature` header using HMAC-SHA256 with `SLACK_SIGNING_SECRET`
2. `X-Slack-Request-Timestamp` header (5-minute window, prevents replay attacks)
3. Responds to Slack's URL verification challenge automatically

**Token storage:** Store all Slack credentials in `~/.dork/relay/adapters.json` under the existing `password`-type field pattern. The existing `maskSensitiveFields()` in `AdapterManager` will mask them in API responses.

**Credential set for Socket Mode adapter config:**

```typescript
export const SlackAdapterConfigSchema = AdapterConfigBaseSchema.extend({
  type: z.literal('slack'),
  botToken: z.string().describe('xoxb-... Bot Token'), // password field
  signingSecret: z.string().describe('Signing Secret'), // password field
  appToken: z.string().describe('xapp-... App-Level Token'), // password field (Socket Mode)
});
```

---

## Detailed Analysis

### Bolt Initialization — Minimal Viable Adapter

```typescript
import { App } from '@slack/bolt';
import slackifyMarkdown from 'slackify-markdown';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN!,
  // Optional: customize logging
  logger: {
    debug: (msg) => log.debug(msg),
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    setLevel: () => {},
    setName: () => {},
    getLevel: () => 'debug',
  },
});

// Inbound: channel messages
app.message(async ({ message, client, logger }) => {
  if (message.subtype) return; // Ignore edits, file shares, etc.
  const msg = message as MessageEvent; // type narrowing

  relay.publish('relay.human.slack.' + message.channel, {
    text: msg.text ?? '',
    from: msg.user,
    channel: msg.channel,
    ts: msg.ts,
    threadTs: msg.thread_ts, // present if this is a thread reply
    channelType: msg.channel_type, // 'channel' | 'im' | 'group'
  });
});

// Inbound: @mentions
app.event('app_mention', async ({ event, client }) => {
  relay.publish('relay.human.slack.mention.' + event.channel, {
    text: event.text,
    from: event.user,
    channel: event.channel,
    ts: event.ts,
  });
});

// Lifecycle
await app.start();

// Graceful shutdown
process.once('SIGTERM', () => app.stop());
process.once('SIGINT', () => app.stop());
```

### Sending Outbound Messages — Patterns

**Send to a channel (bot is already a member):**

```typescript
await app.client.chat.postMessage({
  channel: channelId, // C1234567890
  text: slackifyMarkdown(agentResponse),
  mrkdwn: true,
});
```

**Reply in thread:**

```typescript
await app.client.chat.postMessage({
  channel: channelId,
  thread_ts: originalMessageTs, // ts of the message that triggered the conversation
  text: slackifyMarkdown(agentResponse),
  mrkdwn: true,
});
```

**Send a DM to a user (two-step):**

```typescript
// Step 1: Open or retrieve the DM channel
const { channel } = await app.client.conversations.open({
  users: userId, // U1234567890
});
// Step 2: Send to the DM channel
await app.client.chat.postMessage({
  channel: channel!.id!,
  text: slackifyMarkdown(agentResponse),
  mrkdwn: true,
});
```

**Cache DM channel IDs** in a `Map<userId, dmChannelId>` to avoid repeated `conversations.open` calls:

```typescript
const dmChannelCache = new Map<string, string>();

async function getDmChannel(userId: string): Promise<string> {
  if (dmChannelCache.has(userId)) return dmChannelCache.get(userId)!;
  const { channel } = await app.client.conversations.open({ users: userId });
  const channelId = channel!.id!;
  dmChannelCache.set(userId, channelId);
  return channelId;
}
```

### DorkOS Relay Adapter Interface Mapping

```typescript
// Mapping Slack event fields to DorkOS relay concepts:

interface SlackInboundContext {
  adapterId: string; // 'slack'
  platform: 'slack';
  channelId: string; // event.channel (C.../D.../G...)
  userId: string; // event.user
  messageId: string; // event.ts  (used as message ID)
  threadId: string | null; // event.thread_ts (null if top-level)
  text: string; // event.text
  channelType: 'channel' | 'im' | 'group'; // event.channel_type
}

// Session key convention (from 20260228_adapter_agent_routing.md):
// relay.agent.{agentId}.slack.{channelId}        (channel session)
// relay.agent.{agentId}.slack.dm.{userId}        (DM session)
// relay.agent.{agentId}.slack.thread.{channelId}.{thread_ts}  (per-thread session)
```

### Typing Indicators

Slack does not have a traditional "typing..." indicator API for bots (unlike Telegram's `sendChatAction`). The recommended alternative:

1. **Immediate acknowledgment message:** Post a brief "Got it, working on it..." message in the thread before the agent starts processing. Then either update it (edit-in-place) or use the streaming API to replace it.
2. **Native streaming API:** The `chat.startStream` response creates a visual streaming indicator in Slack's UI natively — this is the best UX for AI response streaming.

### Testing the Slack Adapter

```typescript
// vi.mock('@slack/bolt') for lifecycle tests
vi.mock('@slack/bolt', () => ({
  App: vi.fn().mockImplementation(() => ({
    message: vi.fn().mockReturnThis(),
    event: vi.fn().mockReturnThis(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1704067200.000100' }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
      conversations: {
        open: vi.fn().mockResolvedValue({ ok: true, channel: { id: 'D1234567890' } }),
      },
      chatStream: vi.fn().mockResolvedValue({
        append: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      }),
    },
  })),
}));
```

---

## Quick Reference: Slack vs Telegram Adapter Implementation

| Concern                 | Telegram (grammY)                   | Slack (Bolt)                                   |
| ----------------------- | ----------------------------------- | ---------------------------------------------- |
| **Initialization**      | `new Bot(token)`                    | `new App({ token, signingSecret, appToken })`  |
| **Start**               | `bot.start()`                       | `app.start()`                                  |
| **Receive message**     | `bot.on('message', handler)`        | `app.message(handler)`                         |
| **Reply**               | `ctx.reply(text)`                   | `say(text)` or `client.chat.postMessage`       |
| **Reply in thread**     | N/A (no threads)                    | `{ thread_ts: event.ts }`                      |
| **Send DM**             | `bot.api.sendMessage(userId, text)` | `conversations.open` + `postMessage` (2 calls) |
| **Message ID**          | `message.message_id` (integer)      | `event.ts` (timestamp string)                  |
| **Sender ID**           | `message.from.id`                   | `event.user`                                   |
| **Channel ID**          | `message.chat.id`                   | `event.channel`                                |
| **Format conversion**   | Built-in MarkdownV2/HTML            | `slackify-markdown` (npm install)              |
| **Streaming response**  | Edit + `ctx.reply` repeatedly       | `client.chatStream()` (native API)             |
| **Credentials**         | 1 (bot token)                       | 3 (bot token + signing secret + app token)     |
| **Local dev setup**     | Zero infrastructure                 | Zero infrastructure (Socket Mode)              |
| **Typing indicator**    | `sendChatAction('typing')`          | None — use immediate ack message               |
| **Rate limit handling** | `@grammyjs/auto-retry`              | Bolt WebClient handles automatically           |

---

## Recommendations Summary

### Mode: Socket Mode

Use `socketMode: true` with `SLACK_APP_TOKEN`. No public URL needed for development or self-hosted production. RTM is deprecated and must not be used.

### SDK: `@slack/bolt` v4

Single package covers all needs. Do not separately install `@slack/web-api` or `@slack/socket-mode`.

### Streaming: Native `chatStream` API

Released October 2025, designed for AI agent use cases. Use `client.chatStream()` over the edit-in-place pattern. Fall back to edit-in-place for environments where the streaming API is unavailable.

### Threading: Always Reply in Threads

Set `thread_ts` on all bot replies. Keeps channels clean. Track `originalTs` per conversation as the thread anchor.

### Markdown: `slackify-markdown`

`npm install slackify-markdown` — v5.0.0, 179K weekly downloads, actively maintained. Pass all agent Markdown output through this before sending.

### DMs: Cache `conversations.open` Results

The two-step DM pattern (`conversations.open` → `postMessage`) should be cached per user in a `Map<userId, dmChannelId>` to avoid redundant API calls.

### Session Keys: Thread-Scoped

Use `${channelId}:${thread_ts ?? message_ts}` as the conversation session key in the binding router to keep agent context per-thread.

---

## Setup Checklist for First Slack Adapter

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. **OAuth & Permissions → Bot Token Scopes:** Add all scopes from Section 3 above
3. **Socket Mode:** Enable → Generate App-Level Token with `connections:write` → copy `xapp-...`
4. **Event Subscriptions:** Enable → Subscribe to Bot Events: `message.channels`, `message.im`, `app_mention`
5. **Install App to Workspace** (requires workspace admin)
6. Copy `SLACK_BOT_TOKEN` (`xoxb-...`) from OAuth & Permissions
7. Copy `SLACK_SIGNING_SECRET` from Basic Information → App Credentials
8. Copy `SLACK_APP_TOKEN` (`xapp-...`) from the app-level token you just generated
9. Set all three as env vars in `~/.dork/config.json` or `.env`
10. In Slack workspace: invite the bot to channels with `/invite @your-bot-name`

Total estimated setup time: 20–30 minutes.

---

## Research Gaps and Limitations

- The `client.chatStream()` Node.js API signature was not directly verified from documentation (docs.slack.dev was inaccessible during this research). The Python SDK equivalent (`chat_stream`) was confirmed. The Node.js helper is confirmed to exist from multiple search results but exact parameter names should be verified from the `@slack/web-api` TypeScript types at runtime.
- Slack's native streaming API (`chat.startStream` etc.) was released in October 2025. The `@slack/bolt` minimum version required to access `chatStream()` was not confirmed — verify the package version supports it.
- Behavior when the Socket Mode WebSocket drops mid-streaming (during a `chatStream` session) was not researched. Implement fallback: catch the error and re-attempt with a fresh `postMessage`.
- Rate limits for `chat.appendStream` were not independently confirmed beyond Slack's statement that it is designed for streaming use cases.

---

## Sources

- [Slack vs Telegram Relay Adapter Comparison (prior research)](research/20260227_slack_vs_telegram_relay_adapter.md)
- [Relay External Adapters — Telegram, Webhook, Plugin Architecture (prior research)](research/20260224_relay_external_adapters.md)
- [Adapter-Agent Routing — Visual Binding System (prior research)](research/20260228_adapter_agent_routing.md)
- [Using Socket Mode | Slack Developer Docs](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Comparing HTTP & Socket Mode | Slack Developer Docs](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/)
- [New features for Slack apps sending AI responses (chat streaming) | Slack Developer Docs](https://docs.slack.dev/changelog/2025/10/7/chat-streaming/)
- [chat.startStream method | Slack Developer Docs](https://docs.slack.dev/reference/methods/chat.startStream/)
- [chat.appendStream method | Slack Developer Docs](https://docs.slack.dev/reference/methods/chat.appendStream/)
- [chat.stopStream method | Slack Developer Docs](https://docs.slack.dev/reference/methods/chat.stopStream/)
- [Sending messages | Bolt for JS | Slack Developer Docs](https://docs.slack.dev/tools/bolt-js/concepts/message-sending/)
- [conversations.replies method | Slack](https://api.slack.com/methods/conversations.replies)
- [Programmatic message threading with your Slack Bot — Medium](https://sean-rennie.medium.com/programatic-message-threading-with-your-slack-bot-688d9d227842)
- [Legacy RTM API | Slack Developer Docs](https://api.slack.com/rtm) (deprecated)
- [Discontinuing support for legacy custom bots and classic apps | Slack Developer Docs](https://docs.slack.dev/changelog/2024-09-legacy-custom-bots-classic-apps-deprecation/)
- [slackify-markdown on npm](https://www.npmjs.com/package/slackify-markdown)
- [slackify-markdown on Socket.dev](https://socket.dev/npm/package/slackify-markdown)
- [The Only Guide to Slack mrkdwn Formatting — DEV Community](https://dev.to/suprsend/the-only-guide-to-slack-mrkdwn-not-markdown-formatting-w-codes-4329)
- [@slack/bolt on GitHub](https://github.com/slackapi/bolt-js)
- [Bolt for JavaScript | Slack Developer Docs](https://tools.slack.dev/bolt-js/)
- [chat.postMessage Reference | Slack Developer Docs](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Slack Rate Limits | Developer Docs](https://docs.slack.dev/apis/web-api/rate-limits/)
- [Rate Limit Changes for Non-Marketplace Apps (May 2025)](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)

---

## Search Methodology

- Searches performed: 8 (plus prior research from 3 existing reports)
- Most productive search terms: `"Slack chat.startStream appendStream nodejs chatStream"`, `"Slack bolt threading thread_ts reply"`, `"slackify-markdown npm"`, `"Slack Socket Mode vs Events API self-hosted 2026"`
- Primary information sources: docs.slack.dev (via search results), npm registry, github.com/slackapi/bolt-js
- Three prior DorkOS research reports incorporated: `20260227_slack_vs_telegram_relay_adapter.md`, `20260224_relay_external_adapters.md`, `20260228_adapter_agent_routing.md`
