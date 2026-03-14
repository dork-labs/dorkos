---
title: "Slack Bolt + Socket Mode: Implementation Best Practices"
date: 2026-03-14
type: implementation
status: active
tags: [slack, bolt, socket-mode, relay, adapter, mrkdwn, rate-limiting, threading, error-handling]
feature_slug: relay-external-adapters
searches_performed: 9
sources_count: 22
---

# Slack Bolt + Socket Mode: Implementation Best Practices

## Context

This research was conducted against the existing DorkOS Slack adapter
(`packages/relay/src/adapters/slack/`). The adapter is already fully implemented
with Socket Mode, streaming via `chat.update`, thread tracking, and mrkdwn
conversion via `slackify-markdown`. The purpose of this report is to identify
gaps and actionable improvements relative to established best practices.

---

## Research Summary

The DorkOS Slack adapter is well-structured and covers the fundamentals correctly.
The primary gaps are: no `logLevel` wiring to the Bolt `App` instance, no
`extendedErrorHandler` for richer error context, no cache TTL/size bounds on the
user/channel name caches, and a potential streaming update storm on rapid LLM
token output that could hit the `chat.update` rate limit. Threading is correctly
implemented using `thread_ts || ts` fallback. The `slackify-markdown` library is
a sound choice, but Slack now also supports a native `markdown` block type for
LLM-generated content that is worth evaluating.

---

## Key Findings

### 1. Socket Mode Is the Correct Choice for DorkOS

Socket Mode is appropriate for an internal self-hosted tool. It eliminates the
public URL requirement, is exempt from the May 2025 rate limit restrictions on
`conversations.history` (which apply only to commercially distributed
non-Marketplace apps), and supports up to 10 concurrent connections. Bolt's
`socketMode: true` flag activates automatic reconnection and connection refresh
handling out of the box — no manual WebSocket management is needed.

Relevant limitation: Socket Mode apps cannot be submitted to the Slack Marketplace.
For DorkOS, this is irrelevant — it is an internal developer tool.

### 2. `logLevel` Should Be Wired Through

Bolt's `App` constructor accepts a `logLevel` option from `@slack/bolt`'s
`LogLevel` enum (`DEBUG`, `INFO`, `WARN`, `ERROR`). The current `SlackAdapter`
does not pass this, so Bolt logs at its default `INFO` level regardless of the
application's log configuration.

**Recommended fix:**

```typescript
import { App, LogLevel } from '@slack/bolt';

const app = new App({
  token: this.config.botToken,
  appToken: this.config.appToken,
  signingSecret: this.config.signingSecret,
  socketMode: true,
  logLevel: isDev ? LogLevel.DEBUG : LogLevel.WARN,
});
```

Or pass a custom logger that wraps the DorkOS logger instance to keep all Bolt
output routed through the application's structured log pipeline.

### 3. `extendedErrorHandler` Provides Better Debug Context

Since Bolt v3.8.0, passing `extendedErrorHandler: true` to the `App` constructor
makes the global error handler receive `{ error, logger, context, body }` rather
than just `error`. This is valuable for tracing which team or channel produced
an error in production.

**Recommended addition to `_start()`:**

```typescript
const app = new App({
  // ... existing config
  extendedErrorHandler: true,
});

app.error(async ({ error, logger, context }) => {
  logger.error(error);
  this.recordError(error);
  // context.teamId, context.userId available here for structured log enrichment
});
```

### 4. Streaming Update Frequency Needs Rate Limiting

The current `handleTextDelta` calls `chat.update` on every incoming text delta.
LLM streaming produces tokens at 20–60/second. Slack's `chat.update` is a Tier 3
method (~50 req/min per channel), which works out to roughly 1 update/1.2 seconds
sustained. At peak token rates, the adapter will saturate this limit quickly.

**Recommended fix — debounce/throttle updates:**

Accumulate text in `streamState` but only call `chat.update` when:
- A minimum interval has elapsed since the last update (e.g., 1,000ms), OR
- The `done` event fires (always do a final update)

```typescript
// Add to ActiveStream interface
lastUpdateAt: number;  // ms timestamp of last chat.update call

const MIN_UPDATE_INTERVAL_MS = 1000; // ~1 update/sec, well under Tier 3 limit

// In handleTextDelta, after accumulating text:
const now = Date.now();
if (now - existing.lastUpdateAt >= MIN_UPDATE_INTERVAL_MS) {
  existing.lastUpdateAt = now;
  await client.chat.update({ ... });
}
// Otherwise just accumulate; the `done` handler always does the final update
```

This keeps perceived latency low while staying well within rate limits.

### 5. Thread Handling Is Correct — One Refinement Available

The current `resolveThreadTs` correctly extracts `threadTs` (already in a thread)
or falls back to `ts` (the original message, starting a new thread). This matches
the canonical Slack pattern:

```typescript
const thread_ts = message.thread_ts || message.ts;
```

One edge case: Bolt's built-in `IgnoringSelfEvents` middleware suppresses
the bot's own messages, which prevents infinite loops when the bot posts in a
thread it is also listening to. This works automatically — no explicit filtering
is needed beyond the existing `bot_id` and `botUserId` checks.

**Note for `app_mention` handler:** When a user @-mentions the bot in a channel
thread, the `app_mention` event contains `thread_ts`. The current `_start()`
passes `app_mention` events through `handleInboundMessage`, which preserves
`event.thread_ts` in `platformData`. This is correct.

### 6. User and Channel Name Caches Need Bounds

`userNameCache` and `channelNameCache` are unbounded `Map` objects. In a long-
running adapter across a busy Slack workspace, these will grow without limit.
The caches are cleared on `_stop()`, but if the adapter runs for weeks without
a restart, this becomes a memory leak.

**Recommended fix — simple LRU or TTL cap:**

```typescript
const MAX_CACHE_SIZE = 500;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Store { name: string, cachedAt: number }
// On set: if cache.size >= MAX_CACHE_SIZE, delete the oldest entry (Map insertion order)
// On get: if Date.now() - entry.cachedAt > CACHE_TTL_MS, delete and re-fetch
```

Alternatively, consider using a small LRU cache library (e.g., `quick-lru` which
is already in many Node.js ecosystems, or `mnemonist/lru-map`).

### 7. Rate Limit 429 Responses Are Handled by Bolt Automatically

The `@slack/web-api` `WebClient` has built-in retry logic that respects the
`Retry-After` header on HTTP 429 responses. By default it uses `retryConfig` with
exponential backoff. This means the existing `wrapSlackCall` try/catch will only
see a failure if all retries are exhausted — which is the correct behavior.

**No action required**, but it is worth noting that the Bolt docs warn: if you
continue sending after a 429, Slack may permanently disable the app. The built-in
retry handles this correctly.

Explicit configuration is available if needed:

```typescript
import { WebClient, retryPolicies } from '@slack/web-api';
// Customize retry behavior on the WebClient directly
const client = new WebClient(token, {
  retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
});
```

### 8. Markdown Conversion: `slackify-markdown` Is Adequate; `markdown` Block Is an Alternative

The current `slackifyMarkdown` from the `slackify-markdown` npm package converts
standard Markdown to Slack's `mrkdwn` dialect. This is a well-established approach.

Slack introduced a native **Markdown Block** (`type: "markdown"`) specifically
for LLM-generated content. Slack itself handles the translation:

```json
{
  "blocks": [
    {
      "type": "markdown",
      "text": "**This is standard Markdown** with `code` and [links](https://example.com)"
    }
  ],
  "text": "Fallback plain text"
}
```

**Tradeoff:**
- `slackify-markdown` (current): converts to `mrkdwn` in a plain text field, works
  everywhere including older clients, simpler API call.
- Markdown Block: lets Slack do the rendering, may handle edge cases better
  (especially LLM output with complex nested formatting), but requires using `blocks`
  instead of `text`, and the `text` field must still be provided for notifications/
  accessibility.

**Recommendation:** The current `slackify-markdown` approach is fine. If rendering
quality becomes an issue with complex agent output (tables, nested lists), switching
to the Markdown Block is a low-effort upgrade. The key change would be in
`outbound.ts`: wrap the mrkdwn string in a `markdown` block and include a plain-
text `text` fallback.

### 9. `chat.postMessage` vs `conversations.open` for DMs

The current outbound implementation posts directly to a channel ID. For DMs, the
inbound `SlackMessageEvent.channel` already provides the DM channel ID (`D...`
prefix) — no need for a `conversations.open` call. This is correct.

The `conversations.open` pattern is only needed when the bot wants to *initiate*
a DM to a user that has not yet messaged the bot. The relay adapter only responds
to inbound messages, so this complexity is correctly avoided.

### 10. Well-Regarded Open-Source Reference Implementations

For architectural reference:

- **[slack-samples/bolt-ts-starter-template](https://github.com/slack-samples/bolt-ts-starter-template)**
  Official Slack TypeScript starter. Key pattern: `app.ts` is thin (just routing),
  all logic lives in `/listeners/{feature}/` subdirectories. Aligns with DorkOS's
  existing `inbound.ts` / `outbound.ts` split.

- **[Lullabot/lullabot-slackbot](https://github.com/Lullabot/lullabot-slackbot)**
  Real-world production bot with a plugin architecture. Each feature is an isolated
  plugin in `src/plugins/`. Worth reviewing for modular handler patterns.

- **[slackapi/bolt-js](https://github.com/slackapi/bolt-js/blob/main/examples/getting-started-typescript/src/app.ts)**
  The canonical TypeScript example from the Bolt authors.

---

## Detailed Analysis

### Socket Mode Reconnection Behavior

Bolt handles WebSocket reconnection automatically. Known behaviors:
- Slack sends a `hello` message on connect that includes `approximate_connection_time`
  (the expected connection duration before Slack forces a refresh).
- Bolt prepares a second connection before the first is terminated for seamless
  handoff. No application-level reconnection code is needed.
- There is a documented issue ([bolt-js #1906](https://github.com/slackapi/bolt-js/issues/1906))
  where Socket Mode can fail to reconnect after certain network errors without
  invoking the error handler. If this is encountered, a health-check pattern
  (e.g., a periodic `auth.test` call) would be a reasonable safeguard.
- The `@slack/socket-mode` `SocketModeClient` exposes `auto_reconnect_enabled`
  (default `true`). This is configured automatically when using Bolt with
  `socketMode: true`.

### Rate Limit Tiers Relevant to This Adapter

| API Method | Tier | Limit | Notes |
|---|---|---|---|
| `chat.postMessage` | Special | 1 msg/sec/channel | Core send method |
| `chat.update` | Special | 1 msg/sec/channel | Streaming update |
| `users.info` | Tier 3 | ~50 req/min | User name resolution |
| `conversations.info` | Tier 3 | ~50 req/min | Channel name resolution |
| `auth.test` | Tier 4 | ~100 req/min | Credential validation |
| `conversations.history` | Tier 1 (non-Mktplace) | 1 req/min, 15 msgs | NOT used by this adapter |

The adapter does not call `conversations.history` — it only reacts to incoming
events. The May 2025 rate limit restrictions on `conversations.history` do not
apply.

The `chat.update` streaming pattern (calling on each token delta) is the primary
risk. See Finding #4 for the debounce solution.

### mrkdwn Syntax Reference (Differences from Standard Markdown)

| Feature | Standard Markdown | Slack mrkdwn |
|---|---|---|
| Bold | `**bold**` | `*bold*` |
| Italic | `*italic*` | `_italic_` |
| Strikethrough | `~~text~~` | `~text~` |
| Code (inline) | `` `code` `` | `` `code` `` (same) |
| Code block | ` ``` ``` ` | ` ``` ``` ` (same) |
| Link | `[text](url)` | `<url\|text>` |
| Unordered list | `- item` | No native syntax; use `•` or `-` manually |
| Blockquote | `> text` | `> text` (same) |
| Heading | `## Heading` | Not supported — renders as literal `##` |

`slackify-markdown` handles bold, italic, links, and code blocks correctly.
It does not convert headings (they render as `*Heading*` bold in mrkdwn, which
is the best available approximation).

### Scopes Required (Current Manifest Is Correct)

The `SLACK_MANIFEST` in `slack-adapter.ts` lists a comprehensive set of scopes.
Verified against best practices:

```
channels:history    ✓ required for public channel messages
channels:read       ✓ required for conversations.info
chat:write          ✓ required for chat.postMessage
groups:history      ✓ required for private channel messages
groups:read         ✓ required for private channel conversations.info
im:history          ✓ required for DM messages
im:read             ✓ required for DM info
im:write            ✓ required for conversations.open (if initiating DMs)
mpim:history        ✓ required for group DM messages
app_mentions:read   ✓ required for app_mention events
users:read          ✓ required for users.info (name resolution)
```

The warning against enabling "Agents & AI Apps" in the setup instructions is
correct and important — it adds user-level scopes that trigger OAuth failures on
most workspace plans that do not allow user-level permission grants.

---

## Actionable Recommendations (Priority Order)

### High Priority

1. **Throttle `chat.update` during streaming** — debounce to ~1 update/second
   to stay within rate limits. The `done` event always flushes the final state.
   See Finding #4 for the implementation pattern.

2. **Wire `logLevel` to the Bolt `App`** — pass `LogLevel.WARN` (or `LogLevel.INFO`)
   in production so Bolt's internal WebSocket reconnection logs are captured by
   the application logger. Currently these go to `console` at INFO level regardless.

3. **Add `extendedErrorHandler: true` + global `app.error()`** — richer error
   context (team, channel, body) is critical for debugging production relay
   failures. See Finding #3.

### Medium Priority

4. **Add cache size/TTL bounds** to `userNameCache` and `channelNameCache` in
   `inbound.ts`. A simple size cap of 500 entries and TTL eviction of 1 hour
   prevents unbounded memory growth in long-running adapters. See Finding #6.

5. **Test the reconnection gap** — add a health-check watchdog that calls
   `auth.test` every 5 minutes to detect silent connection failures that Bolt
   does not automatically recover from (known issue #1906).

### Low Priority

6. **Evaluate the Markdown Block** (`type: "markdown"`) for complex agent output.
   This is a minimal change: wrap the text in a `blocks` array instead of using
   the `text` field directly. Benefit: Slack handles all markdown rendering edge
   cases. Only worthwhile if users report formatting issues with complex output.

7. **Consider `chat:write.public` scope** to allow posting to public channels
   without the bot being invited first. Currently the bot must be `/invite`-ed
   before it receives messages. The `SLACK_MANIFEST.setupSteps` instructions
   note the invitation requirement — adding this scope would be a UX improvement.

---

## Sources & Evidence

- [Using Socket Mode | Bolt for JavaScript](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/) — official Bolt Socket Mode setup
- [Handling Errors | Bolt for JavaScript](https://docs.slack.dev/tools/bolt-js/concepts/error-handling/) — `extendedErrorHandler`, `app.error()`, HTTP receiver handlers
- [Logging | Bolt for JavaScript](https://docs.slack.dev/tools/bolt-js/concepts/logging/) — `LogLevel` enum, custom logger interface
- [Rate Limits | Slack Developer Docs](https://docs.slack.dev/apis/web-api/rate-limits/) — tier definitions, Retry-After, pagination recommendations
- [Rate Limit Changes for Non-Marketplace Apps (May 2025)](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/) — confirms internal apps are exempt
- [Formatting Message Text | Slack Developer Docs](https://docs.slack.dev/messaging/formatting-message-text/) — mrkdwn syntax reference
- [Markdown Block | Slack Developer Docs](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/) — LLM-native markdown block type
- [Best Practices for AI-enabled Apps | Slack Developer Docs](https://docs.slack.dev/ai/ai-apps-best-practices/) — use Markdown Block for LLM output
- [Socket Mode Reconnection Issue #1906](https://github.com/slackapi/bolt-js/issues/1906) — documented reconnect failure scenario
- [SocketModeClient reconnect issue #1500](https://github.com/slackapi/node-slack-sdk/issues/1500) — node-slack-sdk reconnection edge case
- [@slack/socket-mode on npm](https://www.npmjs.com/package/@slack/socket-mode) — `LogLevel`, `auto_reconnect_enabled`
- [Thread handling in Bolt | Medium](https://sean-rennie.medium.com/programatic-message-threading-with-your-slack-bot-688d9d227842) — `thread_ts || ts` pattern
- [bolt-js #1370 — replying in threads](https://github.com/slackapi/bolt-js/issues/1370) — canonical thread reply pattern
- [bolt-ts-starter-template](https://github.com/slack-samples/bolt-ts-starter-template) — official TypeScript Bolt architecture reference
- [Lullabot/lullabot-slackbot](https://github.com/Lullabot/lullabot-slackbot) — production plugin architecture reference
- [Building Slack Bots with Bolt (Hemaks)](https://hemaks.org/posts/building-slack-bots-on-nodejs-with-bolt-api-from-zero-to-production/) — zero-to-production guide with rate limit discussion
- [GitHub Topics: bolt-js](https://github.com/topics/bolt-js) — ecosystem overview
- [mrkdwn guide — DEV Community](https://dev.to/suprsend/the-only-guide-to-slack-mrkdwn-not-markdown-formatting-w-codes-4329) — syntax reference
- [nicoespeon/md-to-slack](https://github.com/nicoespeon/md-to-slack) — alternative JS conversion library
- [Vercel Academy: Bolt Middleware and Logging](https://vercel.com/academy/slack-agents/bolt-nitro-middleware-and-logging) — structured logger integration patterns
- [Socket Mode | Slack API Overview](https://api.slack.com/apis/socket-mode) — connection limit (10), Marketplace restriction
- [Existing DorkOS research: Slack vs Telegram Comparison](research/20260227_slack_vs_telegram_relay_adapter.md) — prior research, rate limit table, scope list

---

## Research Gaps & Limitations

- The specific `chat.update` rate limit tier was not definitively confirmed
  (Slack's docs call it "Special" alongside `chat.postMessage`). The 1/sec per
  channel assumption is based on the `chat.postMessage` documented limit; if
  `chat.update` has a separate stricter tier, the throttle threshold may need
  to be more conservative.
- Slack's behavior when `approximate_connection_time` expires and a connection
  refresh happens mid-stream (partial `chat.update` in-flight) was not tested.
  The `done` event finalization should cover this case, but it is worth noting.
- The `slackify-markdown` npm package maintenance status was not verified in this
  session. The package should be checked periodically given its centrality to
  output quality.

---

## Search Methodology

- Searches performed: 9
- Most productive terms: "@slack/bolt Socket Mode best practices 2025",
  "slack bolt error handling reconnection patterns", "slack bolt logLevel custom logger",
  "Slack bolt thread handling thread_ts reply broadcasting",
  "Slack markdown to blocks mrkdwn conversion best practices",
  "Slack API rate limiting best practices 2025"
- Primary sources: docs.slack.dev, github.com/slackapi, npm package docs
- Prior research leveraged: `research/20260227_slack_vs_telegram_relay_adapter.md`
