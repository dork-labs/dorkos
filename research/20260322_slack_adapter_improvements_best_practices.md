---
title: 'Slack Adapter Improvements — Thread Gating, Dedup, Auth Failures, Splitting, Channel Config'
date: 2026-03-22
type: implementation
status: active
tags:
  [
    slack,
    bolt,
    socket-mode,
    threading,
    mention-gating,
    deduplication,
    auth-failure,
    message-splitting,
    channel-config,
    relay,
    adapter,
  ]
feature_slug: relay-external-adapters
searches_performed: 7
sources_count: 22
---

# Slack Adapter Improvements — Best Practices Research

**Research Date:** 2026-03-22
**Research Mode:** Deep Research
**Context:** Implementing world-class improvements to the existing DorkOS Slack relay adapter. Six areas covered: thread-aware mention gating, DM access control, message splitting, event dedup, auth failure handling, and channel-specific overrides.
**Prior research incorporated:** `20260313_slack_bot_adapter_best_practices.md`, `20260314_slack_bolt_socket_mode_best_practices.md`, `20260318_slack_bot_typing_processing_indicators.md`, `20260322_openclaw_slack_integration_analysis.md`

---

## Research Summary

The existing DorkOS Slack adapter covers the core Socket Mode / Bolt fundamentals correctly. The six improvements targeted here fill real gaps that OpenClaw users identify as their biggest pain points. Thread-aware mention gating requires local state tracking (no API call) using a `Set<string>` of active thread keys populated from inbound bot messages. Message splitting is paragraph-first at 3,500 chars with special handling for unclosed code blocks. Dedup in Socket Mode is simpler than HTTP mode — Slack does not send `X-Slack-Retry-Num` headers via WebSocket, so dedup is achieved by tracking `event_id` values in a bounded LRU Set with a short TTL. Auth failure classification is binary: a small set of Slack error codes (`account_inactive`, `invalid_auth`, `token_revoked`, `not_authed`) are permanently fatal and must call `app.stop()` immediately without retry. Channel-specific overrides follow a simple config map pattern keyed by channel ID.

---

## Key Findings

### 1. Thread-Aware Mention Gating

**Problem:** The default Bolt behavior requires `app_mention` for all channel messages. This creates friction when a conversation is already in progress inside a thread — users must @mention the bot in every reply, which breaks natural dialogue flow. This is OpenClaw's most-requested improvement (Issues #30270, #24760).

**What "bot has participated" means:** The bot has previously sent at least one message with `thread_ts === the current thread_ts`. This is the canonical definition — it does not require the bot to have authored the root message.

**Implementation approach (no API calls):**

Track a local `Set<string>` of active thread keys. Populate it whenever the bot sends a message in a thread. Check it on every inbound channel message.

```typescript
// Thread key format: channelId:thread_ts
// A thread is "active" if the bot has sent at least one message in it

class ThreadParticipationTracker {
  private activeThreads = new Set<string>();
  private threadTimestamps = new Map<string, number>(); // for TTL eviction
  private readonly TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly MAX_SIZE = 1000;

  key(channelId: string, threadTs: string): string {
    return `${channelId}:${threadTs}`;
  }

  markParticipating(channelId: string, threadTs: string): void {
    const k = this.key(channelId, threadTs);
    this.activeThreads.add(k);
    this.threadTimestamps.set(k, Date.now());
    this.evictIfNeeded();
  }

  isParticipating(channelId: string, threadTs: string): boolean {
    const k = this.key(channelId, threadTs);
    if (!this.activeThreads.has(k)) return false;
    const ts = this.threadTimestamps.get(k)!;
    if (Date.now() - ts > this.TTL_MS) {
      this.activeThreads.delete(k);
      this.threadTimestamps.delete(k);
      return false;
    }
    return true;
  }

  private evictIfNeeded(): void {
    if (this.activeThreads.size <= this.MAX_SIZE) return;
    // Evict oldest by insertion order (Map guarantees insertion order)
    const oldest = this.threadTimestamps.entries().next().value;
    if (oldest) {
      this.activeThreads.delete(oldest[0]);
      this.threadTimestamps.delete(oldest[0]);
    }
  }
}
```

**Usage in the message handler:**

```typescript
const threadTracker = new ThreadParticipationTracker();

app.message(async ({ message, client, logger }) => {
  const msg = message as GenericMessageEvent;
  if (msg.subtype) return; // ignore edits, deletions, joins, etc.

  const channelType = msg.channel_type; // 'channel' | 'im' | 'group'
  const isChannel = channelType === 'channel' || channelType === 'group';
  const threadTs = msg.thread_ts;
  const isMentioned = msg.text?.includes(`<@${botUserId}>`);

  if (isChannel) {
    const isActiveThread = threadTs && threadTracker.isParticipating(msg.channel, threadTs);

    if (!isMentioned && !isActiveThread) {
      // In a channel with no @mention and no active thread — ignore
      return;
    }
  }

  // Process the message...
  await processInboundMessage(msg, client);
});

// Mark thread as active after every bot reply in a channel thread
async function sendThreadReply(client, channelId: string, threadTs: string, text: string) {
  await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
  // Mark this thread as one the bot is participating in
  threadTracker.markParticipating(channelId, threadTs);
}
```

**app_mention events still needed:** The `app_mention` event is fired when someone @-mentions the bot. Handle it separately to capture the first mention (which populates the thread tracker for subsequent replies):

```typescript
app.event('app_mention', async ({ event, client }) => {
  // The mention itself is handled via the message handler above (since app_mention
  // also fires message.channels). But if using separate handlers, mark the thread here too.
  // The thread_ts on an app_mention event is the root message ts if mentioned in a thread.
  if (event.thread_ts) {
    threadTracker.markParticipating(event.channel, event.thread_ts);
  }
});
```

**Pros of in-memory tracker:**

- Zero API calls during message processing
- Sub-millisecond lookup
- No Slack API rate limit impact

**Cons:**

- State lost on adapter restart (threads don't persist across DorkOS restarts)
- Memory bounded by TTL + MAX_SIZE

**Recommendation:** In-memory is correct for DorkOS's single-tenant, long-running adapter. Persistence (writing active threads to `~/.dork/relay/slack-threads.json`) is optional but only worthwhile if the adapter is frequently restarted.

**Edge cases:**

- Bot mentioned in a thread it hasn't posted in: `isMentioned` is true, so it processes — correct.
- Bot's first message in an existing thread that it didn't start: after sending, `markParticipating` is called — correct for all subsequent messages.
- Thread where bot authored the root: if the root message is a bot-posted message to a channel, `thread_ts` on replies will equal that root `ts`. The bot needs to call `markParticipating` after posting the root too (since replies will carry that ts as `thread_ts`).
- Someone starts a thread on a bot message in the main channel: same as above — mark the root `ts` when posting the initial bot message.

---

### 2. DM Access Control — Allowlist Mode

**Problem:** Without DM access control, any Slack workspace member who messages the bot can trigger agent actions. For a developer tool running agents with filesystem/code access, this is a serious security concern.

**Implementation:**

```typescript
interface SlackAdapterConfig {
  // ... existing fields
  dmPolicy: 'open' | 'allowlist' | 'disabled';
  dmAllowlist?: string[]; // Slack user IDs (U1234567890)
}

function isDmAllowed(userId: string, config: SlackAdapterConfig): boolean {
  if (config.dmPolicy === 'disabled') return false;
  if (config.dmPolicy === 'open') return true;
  return config.dmAllowlist?.includes(userId) ?? false;
}

// In the message handler, for DM channel types:
if (msg.channel_type === 'im') {
  if (!isDmAllowed(msg.user, this.config)) {
    // Silently ignore, OR send a rejection message (silently is safer for security)
    return;
  }
}
```

**Recommended default:** `allowlist` with the owner's user ID pre-populated. The adapter setup wizard should auto-populate the allowlist using `auth.test` to get the bot's team's admin/installer user ID.

**Silent vs. rejection message:** Silently ignoring unauthorized DMs is safer (no oracle for attackers to confirm the bot exists). A rejection message is friendlier but reveals the bot's access policy. For a developer tool, silent ignore is preferred.

**Pros of allowlist:**

- Explicit access control, no surprises
- Easily extended (add user IDs to the list)

**Cons:**

- Setup friction: users must know their Slack user ID
- No pairing flow (OpenClaw's pairing is more user-friendly but adds complexity)

**Recommendation:** `allowlist` mode is the right default for DorkOS. The owner's user ID should be auto-populated via `auth.test` during adapter startup and stored in config.

---

### 3. Message Splitting — Paragraph-Aware, 4000-Char Limit

**The limit:** Slack's `chat.postMessage` `text` field hard-truncates at 4,000 characters. For AI agent responses (which can be long), splitting is mandatory.

**Goals:**

1. Split on paragraph boundaries (double newlines `\n\n`) first
2. If a single paragraph exceeds the limit, split on single newlines
3. If a single line exceeds the limit, split mid-line at the last word boundary before the limit
4. Never split inside a fenced code block (``` fence must be closed in the same message)
5. All parts go to the same thread

**Code block handling:** Detect open ``` fences. If a split point would leave an unclosed code block, either (a) extend the chunk to include the closing fence, or (b) close the fence in the current chunk and reopen it in the next.

````typescript
function splitForSlack(text: string, maxChars = 3500): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    let splitAt = -1;

    // 1. Try to split on paragraph boundary (double newline) before limit
    const paraIdx = remaining.lastIndexOf('\n\n', maxChars);
    if (paraIdx > 0) {
      splitAt = paraIdx + 2; // include the double newline in prev chunk? No — trim.
    }

    // 2. Fall back to single newline
    if (splitAt < 0 || splitAt < maxChars / 2) {
      const lineIdx = remaining.lastIndexOf('\n', maxChars);
      if (lineIdx > 0) splitAt = lineIdx + 1;
    }

    // 3. Fall back to last word boundary
    if (splitAt < 0 || splitAt < maxChars / 4) {
      const spaceIdx = remaining.lastIndexOf(' ', maxChars);
      if (spaceIdx > 0) splitAt = spaceIdx + 1;
    }

    // 4. Hard split (pathological case: no whitespace)
    if (splitAt < 0) splitAt = maxChars;

    let chunk = remaining.slice(0, splitAt).trimEnd();
    remaining = remaining.slice(splitAt).trimStart();

    // 5. Ensure code blocks are closed
    chunk = ensureCodeBlockClosed(chunk);

    chunks.push(chunk);
  }

  if (remaining.length > 0) chunks.push(remaining.trimEnd());
  return chunks;
}

function ensureCodeBlockClosed(chunk: string): string {
  // Count unmatched ``` fences
  const fenceMatches = chunk.match(/```/g);
  const fenceCount = fenceMatches ? fenceMatches.length : 0;
  if (fenceCount % 2 !== 0) {
    // Odd number of fences — the last one is unclosed
    return chunk + '\n```';
  }
  return chunk;
}
````

**Note:** Use 3,500 as the soft limit (not 4,000) to account for mrkdwn conversion overhead — `slackify-markdown` may expand some constructs slightly.

**Sending split messages:**

```typescript
async function sendSplitMessage(
  client: WebClient,
  channelId: string,
  threadTs: string,
  text: string
): Promise<void> {
  const chunks = splitForSlack(slackifyMarkdown(text));

  for (const chunk of chunks) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: chunk,
      mrkdwn: true,
    });
    // Rate limit: 1 msg/sec per channel — add a small delay between chunks
    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 1100)); // slightly over 1 sec to be safe
    }
  }
}
```

**Pros:**

- Never truncates content
- Paragraph splits feel natural in Slack's UI
- All parts in the same thread maintains conversational context

**Cons:**

- Multiple messages can feel spammy for very long responses (3+ chunks)
- 1.1s delay per chunk means a 3-chunk response takes ~2.2s extra

**Alternative:** Use the native streaming API (`chatStream`) — it handles long content natively without splitting. Splitting is only needed as a fallback when streaming is not used.

**Recommendation:** Implement both. Use `chatStream` as the primary path. Use `splitForSlack` as the fallback when the streaming API is unavailable or not configured.

---

### 4. Event Deduplication

**Context — Socket Mode vs. HTTP Events API:**

In the **HTTP Events API**, Slack adds `X-Slack-Retry-Num` and `X-Slack-Retry-Reason` headers to retry requests. Responding with `X-Slack-No-Retry: 1` disables further retries for that event.

In **Socket Mode** (what DorkOS uses), the behavior is different:

- The app acknowledges each event by sending a response with the `envelope_id`
- Bolt does this acknowledgment automatically via `ack()` in each handler
- **Slack only retries if no acknowledgment is received** — if Bolt's `ack()` fires, there will be no retry
- There is **no `X-Slack-Retry-Num` header** in Socket Mode (that's HTTP only)
- However, there are **known bugs in bolt-js** where duplicate events are delivered (Issue #2188 — two events with the same `event_id` delivered, one marked retry and two first-tries)

**Sources of duplicate events in Socket Mode:**

1. Bolt-js issue #2188: WebSocket reconnection during event delivery can cause the same `event_id` to be delivered twice
2. `message_changed` subtype: Slack delivers a new event when a message is edited; without filtering, this retriggers handler logic
3. `message_deleted` subtype: Same
4. Bot's own messages: Bolt has built-in `ignoreSelf` middleware but this can be bypassed in certain edge cases

**Recommended dedup strategy:**

```typescript
class EventDeduplicator {
  private seenEvents = new Map<string, number>(); // event_id -> timestamp
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_SIZE = 500;

  isDuplicate(eventId: string): boolean {
    this.evict();
    if (this.seenEvents.has(eventId)) return true;
    this.seenEvents.set(eventId, Date.now());
    if (this.seenEvents.size > this.MAX_SIZE) {
      // Evict oldest
      const oldest = this.seenEvents.keys().next().value;
      if (oldest) this.seenEvents.delete(oldest);
    }
    return false;
  }

  private evict(): void {
    const now = Date.now();
    for (const [id, ts] of this.seenEvents) {
      if (now - ts > this.TTL_MS) this.seenEvents.delete(id);
    }
  }
}

const deduplicator = new EventDeduplicator();

app.message(async ({ message, body }) => {
  // Filter out non-user messages by subtype
  if ((message as any).subtype) return; // message_changed, message_deleted, bot_message, etc.

  // Dedup by event_id (present on all Events API payloads)
  const eventId = (body as any).event_id as string | undefined;
  if (eventId && deduplicator.isDuplicate(eventId)) {
    logger.debug({ eventId }, 'Dropping duplicate event');
    return;
  }

  // Process...
});
```

**Filtering message subtypes explicitly:**

Bolt exposes a `subtype` filter helper:

```typescript
import { subtype } from '@slack/bolt';

// These handlers run ONLY for the specific subtypes — they do NOT run for regular messages:
app.message(subtype('message_changed'), async ({ message }) => {
  // Handle edits if needed (e.g., update a previous response)
  // By default, ignore — just having this handler prevents the main handler from seeing edits
});

app.message(subtype('message_deleted'), async () => {
  // Ignore deletions
});
```

**Key recommendation:** The `subtype` check `if (message.subtype) return;` at the top of the main handler is the simplest and most reliable approach. It filters ALL subtypes in one check, which prevents `message_changed` (edits) and `message_deleted` from triggering agent logic.

**Pros of event_id dedup:**

- Handles bolt-js #2188 duplicate delivery bug
- No false positives (event_id is globally unique per Slack event)
- Tiny memory footprint (500 entries × ~100 bytes = ~50KB)

**Cons:**

- 5-minute TTL means in-order duplicates within the window are deduplicated, but late arrivals (>5min) are not — acceptable for this use case

---

### 5. Graceful Auth Failure Handling

**The problem:** When Slack credentials are invalid or revoked, Bolt's WebSocket client will attempt to reconnect indefinitely. This creates a retry loop that floods logs, consumes resources, and masks the real error.

**Fatal error codes (should trigger immediate stop, no retry):**

| Error Code                | Meaning                                  | Retryable?                    |
| ------------------------- | ---------------------------------------- | ----------------------------- |
| `account_inactive`        | Bot's Slack account has been deactivated | Never                         |
| `invalid_auth`            | Token is malformed or otherwise invalid  | Never                         |
| `token_revoked`           | Token was explicitly revoked             | Never                         |
| `not_authed`              | No token provided (configuration error)  | Never                         |
| `missing_scope`           | Bot lacks a required OAuth scope         | Never (requires reinstall)    |
| `team_access_not_granted` | Workspace admin restricted bot           | Never (requires admin action) |
| `app_uninstalled`         | Bot was uninstalled from workspace       | Never                         |

**Retryable conditions (Bolt handles these automatically):**

| Condition                     | Bolt behavior                      |
| ----------------------------- | ---------------------------------- |
| Network timeout               | Bolt reconnects automatically      |
| `rate_limited` (429)          | Bolt respects `Retry-After` header |
| Transient server errors (503) | Bolt retries with backoff          |
| Socket drop / WebSocket close | Bolt reconnects automatically      |

**Implementation:**

```typescript
// During App construction:
const app = new App({
  token: this.config.botToken,
  appToken: this.config.appToken,
  signingSecret: this.config.signingSecret,
  socketMode: true,
  extendedErrorHandler: true,
});

const FATAL_SLACK_ERRORS = new Set([
  'account_inactive',
  'invalid_auth',
  'token_revoked',
  'not_authed',
  'missing_scope',
  'team_access_not_granted',
  'app_uninstalled',
]);

app.error(async ({ error, logger }) => {
  const code = (error as any)?.data?.error ?? (error as any)?.code ?? '';

  if (FATAL_SLACK_ERRORS.has(code)) {
    logger.error({ code }, 'Fatal Slack auth error — stopping adapter. Re-check credentials.');
    this.recordError(error);
    // Stop immediately, do not restart
    await this.stop();
    return;
  }

  // Non-fatal: log and let Bolt handle reconnection
  logger.warn({ code, message: error.message }, 'Slack adapter error (non-fatal)');
  this.recordError(error);
});
```

**Startup validation (fail fast):**

Validate credentials before starting the WebSocket connection to catch configuration errors immediately:

```typescript
async _start(): Promise<void> {
  // Pre-flight auth check before starting Bolt
  try {
    const authResult = await new WebClient(this.config.botToken).auth.test();
    this.botUserId = authResult.user_id as string;
    this.botTeamId = authResult.team_id as string;
    this.log.info({ userId: this.botUserId }, 'Slack credentials validated');
  } catch (err: any) {
    const code = err?.data?.error ?? '';
    const isFatal = FATAL_SLACK_ERRORS.has(code);
    this.log.error({ code, isFatal }, 'Slack credential validation failed');
    throw new Error(`Slack auth failed (${code}): ${isFatal ? 'check your tokens' : 'transient error, will retry'}`);
  }

  // Now start Bolt (WebSocket connection)
  await this.app.start();
}
```

**deferInitialization pattern:** Bolt has a documented bug where `account_inactive` errors during `app.start()` can bypass try/catch when using certain initialization patterns. The mitigation is:

```typescript
// Safe initialization — always await both init() and start() separately:
const app = new App({
  token: this.config.botToken,
  // ...
  deferInitialization: true, // do not call auth.test() in constructor
});

try {
  await app.init(); // validates token, throws synchronously on auth error
  await app.start(); // starts WebSocket connection
} catch (err) {
  // auth errors are now properly caught here
  this.handleFatalError(err);
}
```

**Recommendation:** Use both the pre-flight `auth.test` check AND `deferInitialization: true` for belt-and-suspenders auth failure detection.

---

### 6. Thread-First Responses — Always Reply in Threads in Channels

**Context:** This is already in the existing adapter's threading logic. Documenting the complete canonical pattern for completeness.

**Rule:** In channels and groups, always set `thread_ts`. In DMs (`channel_type === 'im'`), do NOT set `thread_ts` — DMs don't have threads and setting it creates a confusing sub-conversation visual.

```typescript
function resolveThreadTs(message: GenericMessageEvent): string | undefined {
  if (message.channel_type === 'im') return undefined; // No thread in DMs
  // In channels: reply in the same thread as the triggering message
  return message.thread_ts ?? message.ts;
}

async function postReply(
  client: WebClient,
  message: GenericMessageEvent,
  text: string
): Promise<string> {
  const threadTs = resolveThreadTs(message);
  const result = await client.chat.postMessage({
    channel: message.channel,
    thread_ts: threadTs,
    text,
    mrkdwn: true,
  });
  // Mark this thread as active (for mention gating)
  if (threadTs) {
    threadTracker.markParticipating(message.channel, threadTs);
  }
  return result.ts as string;
}
```

**reply_broadcast:** Setting `reply_broadcast: true` on a thread reply causes Slack to also post a summary to the main channel. This is almost always wrong for AI agent responses — it defeats the purpose of threading. Do not use it.

---

### 7. Channel-Specific Behavior Overrides

**Use case:** Different behavior in `#ops` (no mention required) vs. `#general` (strict mention gating). Or specific channels where the bot should never respond.

**Pattern — channel config map:**

```typescript
interface ChannelOverrideConfig {
  requireMention?: boolean; // override global mention-gating setting
  enabled?: boolean; // false = bot never responds in this channel
  dmPolicy?: 'open' | 'allowlist' | 'disabled'; // N/A for channels, kept for DM overrides
  threadOnly?: boolean; // if true, only respond to thread messages (not root)
}

interface SlackAdapterConfig {
  // ... existing fields
  requireMention: boolean; // global default
  channelOverrides?: Record<string, ChannelOverrideConfig>; // keyed by channel ID (C1234567890)
}
```

**Usage:**

```typescript
function getEffectiveChannelConfig(
  channelId: string,
  globalConfig: SlackAdapterConfig
): { requireMention: boolean; enabled: boolean } {
  const override = globalConfig.channelOverrides?.[channelId];
  return {
    requireMention: override?.requireMention ?? globalConfig.requireMention,
    enabled: override?.enabled ?? true,
  };
}

// In the message handler:
const effective = getEffectiveChannelConfig(msg.channel, this.config);
if (!effective.enabled) return;
if (effective.requireMention && !isMentioned && !isActiveThread) return;
```

**Channel ID vs. channel name:** Always use channel IDs (not names). Channel names can be renamed; IDs are stable forever. The IDs are visible in Slack URLs and via `conversations.list`.

**Dynamic channel additions:** When the bot is added to a new channel (`member_joined_channel` event with `inviter` set), it can apply the global default config automatically. No special handling needed — the channel ID simply won't be in `channelOverrides` and the global default applies.

```typescript
// Optional: log when bot is added to a new channel
app.event('member_joined_channel', async ({ event }) => {
  if (event.user === this.botUserId) {
    this.log.info({ channel: event.channel }, 'Bot added to new channel — using default config');
  }
});
```

**Pros of channel ID map:**

- Zero performance cost (hash map lookup)
- Explicit and auditable (IDs are stable)
- Works for arbitrary channel-specific rules

**Cons:**

- Requires knowing channel IDs upfront (users must look them up in Slack URLs or use `/api/conversations.list`)
- No dynamic pattern matching (can't say "all channels named #ops-\*")

**Alternative — channel name matching:** Look up channel names via `conversations.info` and cache them (already done in the existing adapter's `channelNameCache`). Then allow overrides to be specified by channel name. Downside: adds an API call on first message per channel, and names can change.

**Recommendation:** Channel ID map is correct and sufficient for DorkOS's developer audience (Kai will know his channel IDs). Add a `_resolveChannelId(nameOrId)` helper to let users specify either format in the config.

---

## Implementation Priority Order

| Priority | Improvement                                                       | Effort | Impact                                             |
| -------- | ----------------------------------------------------------------- | ------ | -------------------------------------------------- |
| 1        | Event dedup (`subtype` filter + `event_id` Set)                   | 30 min | Prevents double-processing, production correctness |
| 2        | Auth failure fast-fail (FATAL_SLACK_ERRORS + deferInitialization) | 45 min | Eliminates retry loops, clear error messages       |
| 3        | Thread-aware mention gating (ThreadParticipationTracker)          | 1 hour | Biggest UX improvement, OpenClaw's top request     |
| 4        | DM allowlist enforcement                                          | 30 min | Security baseline                                  |
| 5        | Message splitting (splitForSlack)                                 | 45 min | Correctness for long agent responses               |
| 6        | Channel-specific overrides (channelOverrides config map)          | 30 min | Power user feature                                 |
| 7        | Thread-first responses (already implemented)                      | 0 min  | Verify existing behavior is correct                |

---

## Complete Configuration Schema (Updated)

```typescript
export const SlackAdapterConfigSchema = AdapterConfigBaseSchema.extend({
  type: z.literal('slack'),

  // Credentials (existing)
  botToken: z.string().describe('xoxb-... Bot Token'),
  signingSecret: z.string().describe('Signing Secret'),
  appToken: z.string().describe('xapp-... App-Level Token (Socket Mode)'),

  // DM access control (NEW)
  dmPolicy: z.enum(['open', 'allowlist', 'disabled']).default('allowlist'),
  dmAllowlist: z.array(z.string()).optional().describe('Slack user IDs allowed to DM'),

  // Mention gating (ENHANCED)
  requireMention: z.boolean().default(true).describe('Require @mention in channels'),
  threadAwareMentionGating: z
    .boolean()
    .default(true)
    .describe('In active threads, do not require @mention even if requireMention=true'),

  // Channel overrides (NEW)
  channelOverrides: z
    .record(
      z.object({
        enabled: z.boolean().optional(),
        requireMention: z.boolean().optional(),
        threadOnly: z.boolean().optional(),
      })
    )
    .optional()
    .describe('Per-channel behavior overrides, keyed by channel ID'),

  // Thread participation tracking TTL
  threadParticipationTtlHours: z
    .number()
    .default(24)
    .describe('How long to remember bot-participated threads (hours)'),
});
```

---

## Dedup Decision Tree (Summary)

```
Inbound event arrives
  │
  ├─ event.subtype exists? → SKIP (edit, delete, join, bot_message, etc.)
  │
  ├─ event_id already seen in dedup Set? → SKIP (duplicate delivery)
  │
  ├─ channel_type === 'im'?
  │   ├─ dmPolicy === 'disabled'? → SKIP
  │   ├─ dmPolicy === 'allowlist' && user not in dmAllowlist? → SKIP
  │   └─ otherwise → PROCESS
  │
  └─ channel_type === 'channel' or 'group'?
      ├─ channelOverrides[channelId].enabled === false? → SKIP
      ├─ @mentioned in message text? → PROCESS
      ├─ threadAwareMentionGating && bot is active in thread_ts? → PROCESS
      └─ requireMention && not mentioned? → SKIP
```

---

## Sources & Evidence

**Prior DorkOS research (primary):**

- [Slack Bot Adapter Best Practices (2026-03-13)](research/20260313_slack_bot_adapter_best_practices.md) — Socket Mode, threading, streaming, mrkdwn
- [Slack Bolt + Socket Mode Implementation (2026-03-14)](research/20260314_slack_bolt_socket_mode_best_practices.md) — Rate limits, error handling, cache bounds
- [Slack Bot Typing & Processing Indicators (2026-03-18)](research/20260318_slack_bot_typing_processing_indicators.md) — Reactions, typing, streaming
- [OpenClaw Slack Integration Analysis (2026-03-22)](research/20260322_openclaw_slack_integration_analysis.md) — Thread-aware gating (issues #30270, #24760), dedup patterns, auth failure patterns

**Slack official documentation:**

- [Using Socket Mode | Slack Developer Docs](https://docs.slack.dev/apis/events-api/using-socket-mode/) — envelope_id acknowledgment, no HTTP retry headers in Socket Mode
- [Handling Errors | Bolt for JavaScript](https://docs.slack.dev/tools/bolt-js/concepts/error-handling/) — extendedErrorHandler, app.error()
- [Listening to messages | Bolt for JavaScript](https://tools.slack.dev/bolt-js/concepts/message-listening/) — subtype filter helper
- [tokens_revoked event | Slack Developer Docs](https://docs.slack.dev/reference/events/tokens_revoked/) — token revocation event structure

**bolt-js GitHub issues:**

- [Issue #2188: Receiving multiple events in Socket Mode](https://github.com/slackapi/bolt-js/issues/2188) — duplicate event_id delivery bug
- [Issue #2071: deferInitialization option](https://github.com/slackapi/bolt-js/issues/2071) — safe initialization pattern for auth errors
- [Issue #367: Handle token revocation](https://github.com/slackapi/node-slack-sdk/issues/367) — token revocation handling

**OpenClaw community evidence:**

- [OpenClaw Issue #30270: Thread-aware requireMention](https://github.com/openclaw/openclaw/issues/30270) — community demand for this feature
- [OpenClaw Issue #24760: Bot participation detection](https://github.com/openclaw/openclaw/issues/24760) — implementation approach analysis

---

## Research Gaps & Limitations

- The exact behavior of `deferInitialization` with Socket Mode specifically (vs. HTTP mode) was not confirmed from docs — the bolt-js issue thread mentions it but the official docs don't highlight the Socket Mode interaction. Verify at integration time.
- Message splitting behavior with `slackify-markdown` applied before splitting (vs. after) was not benchmarked. Splitting before mrkdwn conversion is safer but means the split point is in raw Markdown, not rendered mrkdwn.
- The `channelOverrides` config with human-readable channel names (vs. IDs) as keys was not tested — a `_resolveChannelId` helper would be needed for name-based overrides.
- TTL values (24 hours for thread participation, 5 minutes for event dedup) are engineering judgment calls, not benchmarked. They may need tuning based on real usage patterns.
- Behavior of `threadTracker` across agent restarts (state loss) is a known limitation with no mitigation implemented here. If persistence matters, write/read from `~/.dork/relay/slack-state.json`.

---

## Search Methodology

- Searches performed: 7 (supplemental to 4 existing research files read in full)
- Most productive terms: "Slack X-Slack-Retry-Num socket mode dedup", "Slack account_inactive token_revoked fatal error handling", "Slack bolt message_changed subtype filter typescript", "Slack per-channel bot configuration override pattern"
- Primary sources: docs.slack.dev, github.com/slackapi/bolt-js issues, existing DorkOS research corpus
- Heavy leverage of existing research: all 4 specified files read in full before any new searches
