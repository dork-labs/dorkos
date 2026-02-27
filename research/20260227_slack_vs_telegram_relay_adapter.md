# Slack vs Telegram Bot API: Relay Adapter Comparison

**Research Date:** 2026-02-27
**Research Mode:** Deep Research
**Context:** Evaluating Slack as a second messaging adapter alongside an existing Telegram adapter built with grammY.

---

## Research Summary

Slack is significantly more complex to set up than Telegram for a bidirectional message bridge. Telegram requires only a BotFather token and a webhook URL to start receiving and sending messages. Slack requires creating an app in a developer portal, configuring granular OAuth scopes, handling workspace-level installation, verifying HMAC signatures on every incoming request, and either exposing a public HTTP endpoint or maintaining a persistent WebSocket connection. The Slack Bolt SDK (`@slack/bolt`) is the official framework and is well-maintained, but the surface area it wraps is considerably larger than grammY's.

---

## Key Findings

1. **Bot Creation Complexity**: Telegram bot creation is a single Telegram conversation with @BotFather taking under two minutes. Slack requires navigating the api.slack.com developer portal, configuring an app manifest with scopes and event subscriptions, installing to a workspace, and copying two separate secrets (signing secret + bot token).

2. **Receiving Messages**: Telegram supports both long polling (no infrastructure needed) and webhooks. Slack offers HTTP webhooks (requires public URL, HMAC verification, 3-second response SLA) or Socket Mode (WebSocket, no public URL needed, max 10 connections, not suitable for Marketplace apps).

3. **Sending Messages**: Both platforms use a simple HTTP POST. Telegram's `sendMessage` takes a `chat_id`. Slack's `chat.postMessage` takes a `channel` (can be a channel ID, DM ID, or user ID for opening a new DM). Slack's Block Kit adds structured rich text capabilities not present in Telegram.

4. **Authentication**: Telegram uses a single bot token from BotFather. Slack requires two values: a `SLACK_BOT_TOKEN` (`xoxb-...`) for API calls and a `SLACK_SIGNING_SECRET` for verifying that incoming webhook payloads are genuinely from Slack.

5. **Rate Limits**: Both platforms limit sending to approximately 1 message per second per chat/channel. Telegram allows ~30 messages/second across all chats globally. Slack's 2025 changes introduced tighter restrictions for non-Marketplace apps on history-reading methods (not sending).

6. **Node.js SDKs**: Telegram has grammY (best choice, actively maintained daily, excellent TypeScript support) and Telegraf (legacy, 2 years without update). Slack has the official `@slack/bolt` (v4.6.0, maintained by Slack's team, 2.8k GitHub stars).

7. **Message Format**: Telegram uses plain text with optional HTML/Markdown parse mode. Slack uses its own `mrkdwn` dialect (not standard Markdown) or the modern Block Kit JSON structure for rich messages.

8. **Setup Complexity**: Telegram setup is roughly 5 minutes. Slack setup requires workspace admin access, portal configuration, scope selection, event subscription wiring, and either ngrok/tunnel for local development or a deployed public URL.

---

## Detailed Analysis

### 1. Bot Creation Process

#### Telegram

1. Open Telegram, search for `@BotFather` (official, blue checkmark).
2. Send `/newbot`.
3. Provide a display name and a username ending in `bot`.
4. BotFather returns a token string in the format `123456789:ABCDefGHijklMNOpqrSTUvwxYZ`.
5. Done. Total time: 2–3 minutes.

**Credentials needed:** One bot token.

#### Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click "Create New App".
2. Choose "From an app manifest" or "From scratch".
3. Select the target workspace.
4. Configure **OAuth scopes** under "OAuth & Permissions" (bot token scopes).
5. Configure **Event Subscriptions**: enable, set a Request URL or enable Socket Mode.
6. Subscribe to the specific **bot events** you need (e.g., `message.channels`, `message.im`, `app_mention`).
7. Install the app to the workspace (triggers the OAuth flow, grants a bot token).
8. Copy two values from the app portal:
   - **Signing Secret** (Basic Information → App Credentials)
   - **Bot Token** (`xoxb-...`) (OAuth & Permissions → Bot User OAuth Token)

**Credentials needed:** `SLACK_SIGNING_SECRET` + `SLACK_BOT_TOKEN`. For Socket Mode, an additional **App-Level Token** (`xapp-...`) with `connections:write` scope.

**Key friction:** The app must be *installed to a workspace*, meaning someone with workspace admin rights must approve or perform the installation. This is a significant difference from Telegram where there is no concept of workspace-level permission.

---

### 2. Receiving Messages

#### Telegram

Two modes, both well-supported by grammY:

**Long Polling** (`getUpdates`):
- No infrastructure needed — the bot polls Telegram servers.
- Simple for local development.
- Telegram queues updates; the bot fetches them in batches.
- Cannot coexist with webhooks (Telegram enforces this).

**Webhooks** (`setWebhook`):
- Bot registers a public HTTPS URL.
- Telegram POSTs JSON payloads to that URL on each update.
- Requires a valid TLS certificate (Telegram provides a self-signed option or accepts Let's Encrypt).
- Preferred for production.

Both modes return the same `Update` object structure. grammY handles switching between them transparently.

#### Slack

Two modes with significant tradeoffs:

**HTTP Events API** (recommended for production):
- Slack POSTs JSON event payloads to your public Request URL (must end in `/slack/events` for Bolt).
- **Your server must respond within 3 seconds** with HTTP 200, or Slack retries.
- You **must verify the HMAC-SHA256 signature** on every request (Bolt handles this automatically).
- Slack retries failed deliveries, so your handler must be idempotent.
- Requires a publicly accessible URL — local development needs ngrok, Cloudflare Tunnel, or similar.
- Required for Slack Marketplace submission.

**Socket Mode** (development / behind-firewall):
- Slack initiates a WebSocket connection to your server (no public URL needed).
- Maximum 10 concurrent connections per app.
- Not allowed for Marketplace apps.
- Connection is long-lived and can drop; Bolt has reconnection logic but WebSocket reliability is lower than HTTP.
- Recommended only for local dev or internal tools that cannot expose a public endpoint.

**Event subscription setup** — you must explicitly subscribe to each event type in the portal:
- `message.channels` — messages in public channels the bot is in
- `message.im` — direct messages to the bot
- `message.groups` — messages in private channels the bot is in
- `app_mention` — when someone @-mentions the bot

The bot only receives events for channels it has been invited to (unlike Telegram where the bot receives any message sent to it directly).

---

### 3. Sending Messages

#### Telegram

```
POST https://api.telegram.org/bot{TOKEN}/sendMessage
Body: { chat_id: "...", text: "Hello", parse_mode: "HTML" }
```

- `chat_id` can be a user ID, group ID, or channel username.
- Parse modes: `HTML`, `Markdown`, `MarkdownV2`.
- Supports inline keyboards, reply keyboards, file attachments, stickers, etc.

grammY API:
```typescript
await ctx.reply("Hello world");
await bot.api.sendMessage(chatId, "Hello world");
```

#### Slack

```
POST https://slack.com/api/chat.postMessage
Headers: Authorization: Bearer xoxb-...
Body: { channel: "C1234567890", text: "Hello" }
```

- `channel` accepts: channel ID (`C...`), private group ID (`G...`), DM channel ID (`D...`), or a user ID (`U...`) to open/reuse a DM.
- To post in a public channel the bot is **not** a member of, requires the `chat:write.public` scope.
- Text limit: 4,000 characters. Messages over 40,000 characters are truncated.
- Rate limit: 1 message per second per channel (workspace-level limit of several hundred/minute).

Bolt SDK API:
```typescript
await app.client.chat.postMessage({ channel: channelId, text: "Hello" });
// Inside an event handler:
await say("Hello world");
```

**Sending to a specific user as a DM:**
There is a quirk: if you pass a user ID as `channel`, the message appears in the user's DM with Slackbot, not the bot. To DM the user as the bot, you must first open a DM channel via `conversations.open` to get a `D...` channel ID, then use that.

```typescript
const result = await app.client.conversations.open({ users: userId });
const dmChannelId = result.channel.id;
await app.client.chat.postMessage({ channel: dmChannelId, text: "Hello" });
```

This is two API calls vs Telegram's one.

---

### 4. Authentication

#### Telegram

- **Single token**: `123456789:ABCDefGHijklMNOpqrSTUvwxYZ`
- No webhook verification needed (Telegram recommends including a secret in the URL path to prevent spoofed requests, but it is optional).
- Token is passed as part of the URL: `https://api.telegram.org/bot{TOKEN}/...`

#### Slack

**Three values may be needed depending on mode:**

| Credential | Format | Used for |
|---|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` | Making API calls (chat.postMessage, etc.) |
| `SLACK_SIGNING_SECRET` | hex string | Verifying HTTP event payloads |
| `SLACK_APP_TOKEN` | `xapp-...` | Socket Mode only (requires `connections:write` scope) |

**Signature verification** is mandatory for HTTP mode. Slack signs each request with HMAC-SHA256 using your signing secret and a timestamp. Bolt handles this automatically; raw Express apps must do it manually.

For multi-workspace deployments (distributing the app to other workspaces), you additionally need:
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_STATE_SECRET` (for OAuth state validation)

For a single-workspace internal adapter, only the bot token + signing secret are needed.

---

### 5. Rate Limits

#### Telegram

| Scope | Limit |
|---|---|
| Messages per chat | 1 message/second (short bursts allowed) |
| Messages per group/channel | 20 messages/minute |
| Broadcast across all users | ~30 messages/second total |
| Paid broadcasting (`allow_paid_broadcast`) | Up to 1,000 messages/second at 0.1 Stars/message |

Exceeding limits returns HTTP 429 with a `retry_after` field. grammY's flood plugin handles this automatically.

#### Slack

| Method | Tier | Limit |
|---|---|---|
| `chat.postMessage` | Special | 1 message/second/channel, workspace burst cap |
| Most read methods | Tier 2–3 | 20–50 requests/minute |
| `conversations.history` (Marketplace apps) | Tier 3 | 50+ requests/minute, 1,000 messages/request |
| `conversations.history` (non-Marketplace, from May 2025) | Restricted | 1 request/minute, max 15 messages/request |

**2025 Rate Limit Changes (Important):** As of May 29, 2025, newly created non-Marketplace Slack apps face dramatically reduced limits on `conversations.history` and `conversations.replies`. Existing installations are affected from March 3, 2026. This applies to commercially distributed apps not in the Marketplace. Internal apps (installed only to a single workspace you own) are **exempt**. For a DorkOS relay adapter that installs to a user's own workspace, this should not be a concern.

Rate limit exceeded responses return HTTP 429 with `Retry-After` header.

---

### 6. Node.js SDKs

#### Telegram

| Package | Stars | Weekly Downloads | Last Updated | Verdict |
|---|---|---|---|---|
| `grammy` | 3,391 | High | Daily | **Best choice** — modern, TypeScript-native, active |
| `telegraf` | 9,098 | Moderate | 2 years ago | Avoid for new projects — stale |
| `node-telegram-bot-api` | 9,112 | High | 2 months ago | Legacy; not recommended for large projects |

**grammY** (`grammy` on npm, v1.40.1) is the clear winner for new projects:
- Updated daily, 12 open issues (extremely low for a bot framework)
- Full TypeScript with inline Bot API reference hints
- Always tracks the latest Telegram Bot API version
- Large plugin ecosystem (sessions, conversations, rate limiting, etc.)
- Supports both polling and webhooks natively
- Active community and comprehensive documentation

**Telegraf** was the dominant choice for years but has not had a meaningful release in 2+ years. Existing grammY adapter already reflects the correct ecosystem choice.

#### Slack

| Package | Stars | Version | Last Published | Maintainer |
|---|---|---|---|---|
| `@slack/bolt` | 2,800 | 4.6.0 | ~4 months ago | Slack (official) |
| `@slack/web-api` | (part of bolt) | — | — | Slack (official) |

**`@slack/bolt`** is the official Slack framework for Node.js. It wraps:
- The Web API (`@slack/web-api`)
- Events API handling + signature verification
- Socket Mode (`@slack/socket-mode`)
- OAuth flows
- Interactive components (modals, shortcuts, slash commands)

Installation:
```bash
npm install @slack/bolt
```

The package is maintained by Slack's own developer relations team. It is less actively developed than grammY (releases every few months vs daily) but it is the official SDK, so breaking API changes will always be addressed. 328 downstream npm packages depend on it.

**Alternative — raw `@slack/web-api`**: If you only need to make API calls (e.g., sending messages) without the full event-handling framework, `@slack/web-api` is lighter. But for a bidirectional adapter, Bolt is the right choice.

---

### 7. Message Format

#### Telegram

Messages are plain text with optional parse mode:

- **HTML**: `<b>bold</b>`, `<i>italic</i>`, `<code>code</code>`, `<pre>preformatted</pre>`, `<a href="...">link</a>`
- **MarkdownV2**: `**bold**`, `_italic_`, `` `code` ``, `[link](url)` (with strict escaping requirements)
- **No parse mode**: raw plain text

Incoming `Message` objects include: `message_id`, `from` (User), `chat`, `date`, `text`, and optionally `entities` (formatted ranges), `reply_to_message`, media attachments, etc.

For a relay adapter, the key field is `message.text` for the content and `message.from.id` for routing replies.

#### Slack

Slack has two text formatting systems:

**mrkdwn** (Slack's Markdown dialect — note the spelling):
- `*bold*`, `_italic_`, `~strikethrough~`, `` `code` ``, ` ```code block``` `
- Not the same as standard Markdown. Angle brackets not supported for links directly; use `<url|text>` syntax.
- Applied by setting `"type": "mrkdwn"` on text objects.

**Block Kit** (modern, preferred):
- JSON-based structured layout system.
- `rich_text` blocks support full formatting including lists, quotes, inline code.
- Example message payload:
```json
{
  "channel": "C1234567890",
  "blocks": [
    {
      "type": "rich_text",
      "elements": [
        {
          "type": "rich_text_section",
          "elements": [{ "type": "text", "text": "Hello world" }]
        }
      ]
    }
  ],
  "text": "Hello world"
}
```
- The `text` field serves as fallback for notifications/accessibility.

Incoming Slack event payloads for messages are significantly more complex than Telegram. A `message` event includes: `type`, `channel`, `user`, `text`, `ts` (timestamp used as message ID), `team`, `blocks` (if structured), `event_ts`, `channel_type`.

**Message ID / threading**: Slack uses `ts` (a Unix timestamp string like `"1704067200.000100"`) as both the message ID and the thread identifier. Replying to a message requires passing the original `ts` as `thread_ts`.

---

### 8. Setup Complexity

#### Telegram — Estimated Setup Time: 5 minutes

Steps:
1. Chat with @BotFather → get token (2 min)
2. Set `BOT_TOKEN` env var (30 sec)
3. Initialize grammY with token (5 lines of code)
4. Register message handler
5. Call `bot.start()` for polling OR register webhook URL

For the relay adapter specifically:
- No portal configuration required
- No scopes to select
- No workspace admin needed
- Works immediately in local development via long polling

#### Slack — Estimated Setup Time: 30–60 minutes

Steps:
1. Go to api.slack.com/apps → Create app (5 min)
2. Configure app manifest: select scopes, enable events API (10 min)
3. Choose HTTP vs Socket Mode (decision point)
4. If HTTP: set up public URL (ngrok for dev, or deploy first) (10–20 min)
5. Subscribe to events: `message.channels`, `message.im`, etc. (5 min)
6. Install app to workspace (requires admin permission) (5 min)
7. Copy `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` (2 min)
8. Initialize Bolt with both values (10 lines of code)
9. Invite bot to each channel it should monitor (`/invite @botname`)

Additional Slack-specific gotchas:
- The bot only receives messages in channels it has been **explicitly invited to**. In Telegram, DMs arrive automatically.
- To receive DMs, users must start a conversation with the bot first.
- For Socket Mode in production, you must manage WebSocket reconnection and cannot distribute the app publicly.
- `chat:write.public` scope is needed to post to public channels without joining them first.

**Minimal scope set for a bidirectional relay adapter:**
```
Bot Token Scopes:
- channels:history     (read public channel messages)
- channels:read        (list channels)
- chat:write           (send messages)
- chat:write.public    (send to channels without joining)
- im:history           (read DM messages)
- im:write             (open DM channels)
- app_mentions:read    (receive @mentions)

Event Subscriptions (Bot Events):
- message.channels     (messages in public channels)
- message.im           (direct messages to bot)
- app_mention          (when bot is @mentioned)
```

---

## Side-by-Side Comparison Table

| Aspect | Telegram | Slack |
|---|---|---|
| **Bot creation** | BotFather chat, 2 min | Developer portal, 30–60 min |
| **Credentials** | 1 token | Bot token + signing secret (+ app token for Socket Mode) |
| **Receiving messages** | Long polling or webhook | HTTP Events API or Socket Mode |
| **Local dev (no public URL)** | Long polling (built-in) | Socket Mode required |
| **Production receiving** | Webhook (simple) | HTTP Events API (requires public URL + HMAC verification) |
| **Sending a message** | 1 API call | 1 API call (but DMs need 2: `conversations.open` + `postMessage`) |
| **Message rate limit** | 1/sec per chat | 1/sec per channel |
| **Text format** | Plain, HTML, MarkdownV2 | mrkdwn, Block Kit JSON |
| **Message ID** | `message_id` (integer) | `ts` (timestamp string) |
| **Node.js SDK** | grammY (daily updates) | @slack/bolt (official, ~monthly) |
| **SDK quality** | Excellent | Good |
| **Workspace admin needed?** | No | Yes (to install app) |
| **Channel invitation required?** | No | Yes (bot must be invited) |
| **Rate limit (history reading)** | Not a concern | Restricted for non-Marketplace apps since May 2025 |
| **Multi-workspace support** | Built-in (each user has own chat) | Requires full OAuth flow per workspace |
| **Relative adapter complexity** | Low | High |

---

## Implementation Recommendation

Given an existing grammY-based Telegram adapter, adding Slack as a second adapter is feasible but requires significantly more upfront configuration from the user.

**If adding Slack, the adapter should:**
1. Use `@slack/bolt` with **Socket Mode** for the initial version to eliminate the public URL requirement during development and for self-hosted deployments.
2. Provide a clear setup guide (the scope list above is the minimum viable configuration).
3. Map Slack's `ts` field to the relay adapter's message ID concept.
4. Handle the two-step DM pattern (`conversations.open` → `chat.postMessage`) transparently.
5. Note that the bot must be invited to channels before it can see messages there — this is a fundamental difference from Telegram's behavior.

**For parity with the Telegram adapter's bidirectional bridge:**

| Telegram equivalent | Slack implementation |
|---|---|
| `ctx.reply(text)` | `say(text)` or `client.chat.postMessage(...)` |
| `message.from.id` | `event.user` |
| `message.chat.id` | `event.channel` |
| `message.message_id` | `event.ts` |
| `bot.start()` (polling) | `app.start()` (Bolt, handles Socket Mode or HTTP) |
| `bot.on('message', handler)` | `app.message(handler)` |

---

## Research Gaps and Limitations

- Exact weekly npm download counts for `@slack/bolt` could not be retrieved (npmjs.com returned 403). GitHub stars (2,800) and 328 dependent packages are the available indicators.
- Slack's behavior for very high message throughput (burst scenarios relevant to a relay adapter under heavy AI agent output) was not benchmarked.
- Slack's Socket Mode reliability under production load was not independently verified beyond Slack's own documentation noting it as less reliable than HTTP mode.

---

## Sources

- [Slack Events API Documentation](https://docs.slack.dev/apis/events-api/)
- [Comparing HTTP vs Socket Mode | Slack Developer Docs](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/)
- [Slack Rate Limits | Developer Docs](https://docs.slack.dev/apis/web-api/rate-limits/)
- [Rate Limit Changes for Non-Marketplace Apps (May 2025)](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)
- [chat.postMessage Reference | Slack Developer Docs](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Slack Scopes Reference](https://docs.slack.dev/reference/scopes/)
- [Bolt for JavaScript | Slack Developer Docs](https://tools.slack.dev/bolt-js/)
- [Quickstart with Bolt for JavaScript](https://docs.slack.dev/tools/bolt-js/getting-started/)
- [@slack/bolt on GitHub](https://github.com/slackapi/bolt-js)
- [Formatting Message Text | Slack Developer Docs](https://docs.slack.dev/messaging/formatting-message-text/)
- [Rich Text Block | Slack Developer Docs](https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/)
- [Telegram Bot API Official Docs](https://core.telegram.org/bots/api)
- [Telegram Bots FAQ (Rate Limits)](https://core.telegram.org/bots/faq)
- [From BotFather to Hello World | Telegram Tutorial](https://core.telegram.org/bots/tutorial)
- [grammY Framework](https://grammy.dev/)
- [How grammY Compares to Other Frameworks](https://grammy.dev/resources/comparison)
- [npm trends: grammy vs telegraf vs node-telegram-bot-api](https://npmtrends.com/grammy-vs-node-telegram-bot-api-vs-telegraf-vs-telegram-bot-api)
- [grammY Flood/Rate Limit Handling](https://grammy.dev/advanced/flood)
- [Slack Messaging Overview](https://docs.slack.dev/messaging/)
- [Sending and Scheduling Messages | Slack](https://docs.slack.dev/messaging/sending-and-scheduling-messages/)

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: "Slack socket mode vs webhooks events API comparison", "Slack Bot API rate limits 2025", "Slack chat.postMessage direct message channel user ID", "Telegram Bot API rate limits messages per second polling webhooks"
- Primary information sources: docs.slack.dev, core.telegram.org, grammy.dev, npmtrends.com
- Research depth: Deep (10–15 tool calls)
