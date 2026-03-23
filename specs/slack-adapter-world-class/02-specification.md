# World-Class Slack Adapter Improvements

## Status

Draft

## Authors

Claude Code — 2026-03-22

## Overview

Implement 8 targeted improvements to the DorkOS Relay Slack Adapter, informed by OpenClaw's documented pain points (330K GitHub stars, well-cataloged issues) and broader AI Slack bot industry best practices. These improvements make the adapter production-grade for real team workspaces — handling event deduplication, graceful auth failures, intelligent respond modes, DM access control, long message splitting, enforced threading, and per-channel configuration.

All 8 improvements are in-process logic changes. No new Slack API surface is introduced. All new config fields have backward-compatible defaults matching current behavior (except typing indicator, which changes from `'none'` to `'reaction'`).

## Background / Problem Statement

The Slack adapter today handles the core happy path well — Socket Mode connection, inbound message parsing, outbound delivery with streaming, typing indicator reactions, and tool approval cards. However, deploying it in a real team workspace exposes gaps:

1. **Duplicate processing** — bolt-js Issue #2188: WebSocket reconnections in Socket Mode replay events, causing duplicate agent invocations.
2. **Auth failure loops** — When tokens are revoked or scopes change, the adapter retries indefinitely instead of fast-failing with a clear error.
3. **Typing indicator opt-in friction** — The hourglass reaction is fully implemented but defaults to `'none'`, so new users don't see it.
4. **No respond mode control** — The bot responds to every message in every channel. In team workspaces, this is the #1 complaint (OpenClaw Issue #30270). Users need mention-gating in channels while keeping threads conversational.
5. **No DM access control** — Any workspace member can DM the bot. Solo developers don't need this, but teams do.
6. **Message truncation** — Long responses are silently truncated at 4000 chars. Should split into multiple messages instead.
7. **Thread-first not enforced** — `resolveThreadTs()` handles it when platformData is present, but not all code paths guarantee threading in channels.
8. **No per-channel configuration** — Can't disable the bot in specific channels or set channel-specific respond modes.

## Goals

- Eliminate duplicate event processing from Socket Mode reconnections
- Fast-fail on auth failures with descriptive error messages
- Default typing indicator to the already-implemented reaction mode
- Add thread-aware mention gating so the bot only responds when appropriate
- Add DM allowlist for team workspace access control
- Split long messages instead of truncating them, with code-block awareness
- Enforce thread-first responses in all channel code paths
- Enable per-channel configuration overrides
- Maintain full backward compatibility (all new config fields have defaults)
- Keep all state instance-scoped (multi-instance safe)

## Non-Goals

- Adding new Slack API calls or OAuth scopes
- Implementing channel-type routing (e.g., only respond in public channels)
- Rate limiting outbound messages beyond the existing stream update interval
- Adding slash command support
- Implementing message history or context windowing
- Building a web UI for channel override management (config file only)

## Technical Dependencies

- `@slack/bolt` ^4.x (already installed — Socket Mode, event handling)
- `@slack/web-api` (already installed — transitive via bolt)
- No new external dependencies required

## Detailed Design

### Improvement 1: Event Deduplication

**Problem:** bolt-js Issue #2188 — Socket Mode WebSocket reconnections replay events, causing duplicate agent invocations.

**Implementation:** Add an `event_id` LRU Set to `handleInboundMessage()` in `inbound.ts`.

```typescript
// New constants in inbound.ts
const EVENT_DEDUP_MAX_SIZE = 500;
const EVENT_DEDUP_TTL_MS = 5 * 60 * 1_000; // 5 minutes

interface DedupEntry {
  expiresAt: number;
}

// Module-level dedup cache (shared across all instances via the function)
// This is acceptable because event_ids are globally unique per workspace
const seenEvents = new Map<string, DedupEntry>();
```

**Changes to `handleInboundMessage()`** — Add a new `body` parameter (or pass `event_id` directly) and check before processing:

Since `handleInboundMessage()` receives the Slack event from `app.message()` and `app.event('app_mention')`, we need to pass the `event_id` from the Bolt body. The Bolt `body` object contains `event_id` at the top level.

**In `slack-adapter.ts`**, update the `app.message()` and `app.event('app_mention')` handlers to pass `body.event_id`:

```typescript
app.message(async ({ event, client, body }) => {
  await handleInboundMessage(
    event as Parameters<typeof handleInboundMessage>[0],
    client,
    relay,
    this.botUserId,
    this.makeInboundCallbacks(),
    this.logger,
    this.config.typingIndicator ?? 'reaction',
    this.pendingReactions,
    this.codec,
    { eventId: (body as Record<string, unknown>).event_id as string | undefined }
  );
});
```

**In `inbound.ts`**, add dedup options parameter and check:

```typescript
export interface InboundOptions {
  eventId?: string;
  respondMode?: 'always' | 'mention-only' | 'thread-aware';
  dmPolicy?: 'open' | 'allowlist';
  dmAllowlist?: string[];
  channelOverrides?: Record<string, { enabled?: boolean; respondMode?: RespondMode }>;
  threadTracker?: ThreadParticipationTracker;
}

export async function handleInboundMessage(
  event: SlackMessageEvent,
  client: WebClient,
  relay: RelayPublisher,
  botUserId: string,
  callbacks: AdapterInboundCallbacks,
  logger: RelayLogger = noopLogger,
  typingIndicator: 'none' | 'reaction' = 'reaction',
  pendingReactions?: PendingReactions,
  codec?: SlackThreadIdCodec,
  options?: InboundOptions
): Promise<void> {
  // === Event deduplication (first check, before any processing) ===
  if (options?.eventId) {
    const now = Date.now();
    const existing = seenEvents.get(options.eventId);
    if (existing && now < existing.expiresAt) {
      logger.debug(`inbound skipped: duplicate event_id ${options.eventId}`);
      return;
    }
    // Evict expired entries when at capacity
    if (seenEvents.size >= EVENT_DEDUP_MAX_SIZE) {
      for (const [key, entry] of seenEvents) {
        if (now > entry.expiresAt) seenEvents.delete(key);
        else break; // Map iterates in insertion order; stop at first non-expired
      }
      // If still at capacity after expiry sweep, evict oldest
      if (seenEvents.size >= EVENT_DEDUP_MAX_SIZE) {
        const firstKey = seenEvents.keys().next().value;
        if (firstKey !== undefined) seenEvents.delete(firstKey);
      }
    }
    seenEvents.set(options.eventId, { expiresAt: now + EVENT_DEDUP_TTL_MS });
  }

  // ... existing echo prevention, subtype filtering, etc.
}
```

**Add `clearSeenEvents()` to `clearCaches()`:**

```typescript
export function clearCaches(): void {
  userNameCache.clear();
  channelNameCache.clear();
  seenEvents.clear();
}
```

**Files modified:** `inbound.ts`, `slack-adapter.ts`

---

### Improvement 2: Graceful Auth Failure Handling

**Problem:** When Slack tokens are revoked or scopes change, the adapter retries indefinitely.

**Implementation:** Add a set of fatal Slack error codes and check them in `app.error()`.

**In `slack-adapter.ts`:**

```typescript
/** Slack API error codes that indicate permanently invalid credentials. */
const FATAL_SLACK_ERRORS = new Set([
  'account_inactive',
  'invalid_auth',
  'token_revoked',
  'not_authed',
  'missing_scope',
  'team_access_not_granted',
  'app_uninstalled',
]);
```

**Update the `app.error()` handler in `_start()`:**

```typescript
app.error(async (error) => {
  // Check if this is a fatal auth error that should stop the adapter
  const errorCode = (error as Record<string, unknown>)?.code as string | undefined;
  const errorData = (error as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const slackError = errorData?.error as string | undefined;

  if (
    (errorCode && FATAL_SLACK_ERRORS.has(errorCode)) ||
    (slackError && FATAL_SLACK_ERRORS.has(slackError))
  ) {
    const code = slackError ?? errorCode ?? 'unknown';
    this.logger.error(`fatal auth error: ${code} — stopping adapter`);
    this.recordError(
      new Error(`Fatal Slack error: ${code}. Re-check your bot token and app configuration.`)
    );
    // Stop the app to prevent retry loops
    try {
      await this.app?.stop();
    } catch {
      // best-effort
    }
    return;
  }

  this.recordError(error);
});
```

The `recordError()` method (inherited from `BaseRelayAdapter`) already sets the adapter status to `'error'` with the error message, which surfaces in the Relay panel UI.

**Files modified:** `slack-adapter.ts`

---

### Improvement 3: Typing Indicator Default Change

**Problem:** The hourglass reaction is fully implemented and tested but defaults to `'none'`, so new users never see it.

**Implementation:** Change the default in the Zod schema.

**In `packages/shared/src/relay-adapter-schemas.ts`:**

```typescript
// Before:
typingIndicator: z.enum(['none', 'reaction']).default('none'),

// After:
typingIndicator: z.enum(['none', 'reaction']).default('reaction'),
```

**Update the SLACK_MANIFEST configFields** to reflect the new default in the description:

```typescript
{
  key: 'typingIndicator',
  label: 'Typing Indicator',
  type: 'select',
  required: false,
  description: 'Show a visual indicator while the agent is working. Enabled by default.',
  options: [
    { label: 'None', value: 'none' },
    { label: 'Emoji reaction', value: 'reaction', description: 'Adds an hourglass reaction while the agent is processing.' },
  ],
  // ...
}
```

**Backward compatibility:** Existing configs that explicitly set `typingIndicator: 'none'` continue to work. Only new adapters created without specifying this field get the new default.

**Files modified:** `relay-adapter-schemas.ts`, `slack-adapter.ts` (manifest description)

---

### Improvement 4: Thread-Aware Mention Gating (respondMode)

**Problem:** The bot responds to every message in every channel. OpenClaw Issue #30270 — the #1 requested feature.

**New config field:**

```typescript
// In SlackAdapterConfigSchema
respondMode: z.enum(['always', 'mention-only', 'thread-aware']).default('thread-aware'),
```

**RespondMode semantics:**

- `'always'` — Process every message (current behavior)
- `'mention-only'` — Only process messages that @mention the bot
- `'thread-aware'` — Default. DMs always process. Channel messages: only process if @mentioned OR the bot is already participating in the thread

#### ThreadParticipationTracker

Create a new file `packages/relay/src/adapters/slack/thread-tracker.ts`:

```typescript
/**
 * Tracks which threads the bot has participated in.
 *
 * Instance-scoped (not module-level) to support multi-instance adapters.
 * Uses an LRU Map with TTL-based expiration.
 *
 * @module relay/adapters/slack/thread-tracker
 */

const DEFAULT_MAX_SIZE = 1_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

/**
 * Track bot participation in Slack threads for respond-mode gating.
 *
 * Keyed by `${channelId}:${threadTs}`. Max 1,000 entries with 24h TTL
 * and LRU eviction. Instance-scoped for multi-instance safety.
 */
export class ThreadParticipationTracker {
  private readonly entries = new Map<string, number>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = DEFAULT_MAX_SIZE, ttlMs = DEFAULT_TTL_MS) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /** Mark the bot as participating in a thread. */
  markParticipating(channelId: string, threadTs: string): void {
    const key = `${channelId}:${threadTs}`;
    // Delete first to refresh insertion order (LRU)
    this.entries.delete(key);
    // Evict oldest if at capacity
    if (this.entries.size >= this.maxSize) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) this.entries.delete(firstKey);
    }
    this.entries.set(key, Date.now());
  }

  /** Check if the bot is participating in a thread. */
  isParticipating(channelId: string, threadTs: string): boolean {
    const key = `${channelId}:${threadTs}`;
    const timestamp = this.entries.get(key);
    if (timestamp === undefined) return false;
    if (Date.now() - timestamp > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Clear all tracked threads. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of tracked threads (for testing/debugging). */
  get size(): number {
    return this.entries.size;
  }
}
```

#### Inbound gating logic

Add respond mode checks in `handleInboundMessage()` after echo/bot/subtype filtering and after event dedup, but before name resolution:

```typescript
// === Respond mode gating ===
const respondMode = options?.respondMode ?? 'always';
const channelId = event.channel;
const isDm = channelId.startsWith('D');

// Channel overrides (Improvement 8) — check before respond mode
if (options?.channelOverrides) {
  const override = options.channelOverrides[channelId];
  if (override?.enabled === false) {
    logger.debug(`inbound skipped: channel ${channelId} disabled by override`);
    return;
  }
  // Use channel-specific respondMode if set
  if (override?.respondMode) {
    effectiveRespondMode = override.respondMode;
  }
}

// DM policy check (Improvement 5)
if (isDm && options?.dmPolicy === 'allowlist') {
  if (!event.user || !options.dmAllowlist?.includes(event.user)) {
    logger.debug(`inbound skipped: user ${event.user} not in DM allowlist`);
    return;
  }
}

// Respond mode gating (only applies to non-DM channels)
if (!isDm && effectiveRespondMode !== 'always') {
  const hasMention = event.text?.includes(`<@${botUserId}>`) ?? false;
  const threadTs = event.thread_ts;

  if (effectiveRespondMode === 'mention-only') {
    if (!hasMention) {
      logger.debug(`inbound skipped: no mention in mention-only mode (${channelId})`);
      return;
    }
  } else if (effectiveRespondMode === 'thread-aware') {
    if (threadTs) {
      // In a thread — check if bot is participating
      const participating = options?.threadTracker?.isParticipating(channelId, threadTs) ?? false;
      if (!participating && !hasMention) {
        logger.debug(`inbound skipped: not participating in thread ${channelId}:${threadTs}`);
        return;
      }
    } else {
      // Main channel message — only process if @mentioned
      if (!hasMention) {
        logger.debug(`inbound skipped: no mention in main channel ${channelId}`);
        return;
      }
    }
  }
}
```

Note: `app_mention` events from Slack are already pre-filtered by Slack to only fire on @mentions, so they always pass through the gating logic. The explicit `hasMention` check handles `app.message()` events which fire for all messages.

#### Outbound participation tracking

After every successful outbound message (standard, stream start, approval card), mark the thread:

**In `slack-adapter.ts`**, add a `ThreadParticipationTracker` instance:

```typescript
private readonly threadTracker = new ThreadParticipationTracker();
```

Pass it to `handleInboundMessage()` via the options object, and pass it to `deliverMessage()` as well. In `outbound.ts`, after posting any message:

```typescript
// After successful chat.postMessage / stream start / approval card
if (threadTracker && channelId && threadTs) {
  threadTracker.markParticipating(channelId, threadTs);
}
```

Clear the tracker in `_stop()`:

```typescript
this.threadTracker.clear();
```

**Files modified:** `relay-adapter-schemas.ts`, `slack-adapter.ts`, `inbound.ts`
**Files created:** `thread-tracker.ts`

---

### Improvement 5: DM Access Control (dmPolicy)

**Problem:** Any workspace member can DM the bot. Teams need access control.

**New config fields:**

```typescript
// In SlackAdapterConfigSchema
dmPolicy: z.enum(['open', 'allowlist']).default('open'),
dmAllowlist: z.array(z.string()).default([]),
```

**Implementation:** Handled in the inbound gating logic (see Improvement 4 above). The check occurs after echo prevention and before name resolution. Non-allowlisted users are silently ignored (no rejection message — security best practice to avoid revealing the bot's access control configuration).

**New SLACK_MANIFEST configFields:**

```typescript
{
  key: 'dmPolicy',
  label: 'DM Access',
  type: 'select',
  required: false,
  description: 'Control who can DM the bot.',
  section: 'Access Control',
  options: [
    { label: 'Open (anyone)', value: 'open', description: 'Any workspace member can DM the bot.' },
    { label: 'Allowlist only', value: 'allowlist', description: 'Only users in the allowlist can DM the bot.' },
  ],
  displayAs: 'radio-cards',
},
{
  key: 'dmAllowlist',
  label: 'DM Allowlist',
  type: 'textarea',
  required: false,
  description: 'Slack user IDs allowed to DM the bot (one per line). Find user IDs in Slack profile > More > Copy member ID.',
  placeholder: 'U01ABC123\nU02DEF456',
  section: 'Access Control',
  showWhen: { field: 'dmPolicy', equals: 'allowlist' },
}
```

**Note on dmAllowlist type:** The Zod schema uses `z.array(z.string())`, but the config field UI uses a `textarea` with newline-separated values. The adapter constructor should parse the textarea value if it's a string:

```typescript
// In handleInboundMessage or adapter constructor
const allowlist = Array.isArray(config.dmAllowlist)
  ? config.dmAllowlist
  : typeof config.dmAllowlist === 'string'
    ? config.dmAllowlist
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
```

**Files modified:** `relay-adapter-schemas.ts`, `slack-adapter.ts` (manifest + config parsing), `inbound.ts`

---

### Improvement 6: Message Splitting (Shared Utility)

**Problem:** Long responses are silently truncated at 4000 chars via `truncateText()`. Should split into multiple messages with code-block awareness.

#### 6a: Extract to shared utility

Move and enhance the Telegram `splitMessage()` from `packages/relay/src/adapters/telegram/outbound.ts` to `packages/relay/src/lib/payload-utils.ts`.

**New shared function in `payload-utils.ts`:**

````typescript
/** Default max length for Telegram messages. */
export const TELEGRAM_MAX_LENGTH = 4000;

/** Default max length for Slack messages (lower than Slack's 4000 hard limit to account for mrkdwn expansion). */
export const SLACK_MAX_LENGTH = 3500;

/**
 * Split a message into chunks that respect platform length limits.
 *
 * Split priority: paragraph break (`\n\n`) > line break (`\n`) > word boundary (space) > hard cut.
 * Code-block aware: if a split occurs inside an unclosed code fence, the current
 * chunk gets a closing fence and the next chunk gets an opening fence.
 *
 * @param text - The text to split
 * @param maxLen - Maximum length per chunk (default: 4000)
 */
export function splitMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = -1;

    // Priority 1: paragraph break
    const paraBreak = remaining.lastIndexOf('\n\n', maxLen);
    if (paraBreak > 0) {
      splitAt = paraBreak + 2; // include the double newline in current chunk
    }

    // Priority 2: line break
    if (splitAt === -1) {
      const lineBreak = remaining.lastIndexOf('\n', maxLen);
      if (lineBreak > 0) {
        splitAt = lineBreak + 1;
      }
    }

    // Priority 3: word boundary
    if (splitAt === -1) {
      const space = remaining.lastIndexOf(' ', maxLen);
      if (space > 0) {
        splitAt = space + 1;
      }
    }

    // Priority 4: hard cut
    if (splitAt === -1) {
      splitAt = maxLen;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Code-block fence awareness
    const fenceCount = countUnmatchedFences(chunk);
    if (fenceCount % 2 !== 0) {
      // Odd number of fences means we're inside a code block
      chunk += '\n```';
      remaining = '```\n' + remaining;
    }

    chunks.push(chunk);
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Count unmatched triple-backtick fences in a text chunk.
 *
 * @param text - The text to scan
 * @returns Number of ``` occurrences
 */
function countUnmatchedFences(text: string): number {
  let count = 0;
  let idx = 0;
  while (idx < text.length) {
    const pos = text.indexOf('```', idx);
    if (pos === -1) break;
    count++;
    idx = pos + 3;
  }
  return count;
}
````

#### 6b: Refactor Telegram adapter

In `packages/relay/src/adapters/telegram/outbound.ts`, replace the local `splitMessage()` with an import from the shared utility:

```typescript
// Before:
export function splitMessage(text: string, maxLen: number): string[] { ... }

// After:
import { splitMessage } from '../../lib/payload-utils.js';
// Remove the local splitMessage function
```

Telegram call sites pass `maxLen = 4000` (the Telegram default), so no behavioral change.

#### 6c: Use in Slack outbound

In `packages/relay/src/adapters/slack/outbound.ts`, replace `truncateText()` calls with `splitMessage()` and post multiple messages:

```typescript
import { splitMessage, SLACK_MAX_LENGTH } from '../../lib/payload-utils.js';

// In the standard payload delivery path:
const formatted = formatForPlatform(extractPayloadContent(payload), 'slack');
const chunks = splitMessage(formatted, SLACK_MAX_LENGTH);

for (let i = 0; i < chunks.length; i++) {
  await wrapSlackCall(
    () =>
      client.chat.postMessage({
        channel: channelId,
        text: chunks[i],
        thread_ts: threadTs,
      }),
    logger
  );

  // Rate limit: 1.1s delay between chunks (Slack Tier 3: ~50 msgs/min)
  if (i < chunks.length - 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  }
}
```

All chunks are posted to the same thread.

**Files modified:** `payload-utils.ts`, `telegram/outbound.ts`, `slack/outbound.ts`

---

### Improvement 7: Thread-First Responses (Enforced)

**Problem:** `resolveThreadTs()` handles threading when `platformData` is present, but not all code paths guarantee it.

**Implementation:** Verify and enforce that all outbound code paths in channels (C/G-prefix) use `thread_ts`. This is already partially implemented — `resolveThreadTs()` extracts `threadTs` from `platformData.threadTs` or falls back to `platformData.ts`. The key verification points:

1. **Standard message delivery** (`deliverMessage()` in `outbound.ts`): Already uses `resolveThreadTs()`. Verify the resolved value is passed to `chat.postMessage()`.

2. **Stream start** (`handleTextDelta()` in `stream.ts`): The first `chat.postMessage()` that starts a stream must include `thread_ts`. Verify the stream context carries `threadTs`.

3. **Approval cards** (`handleApprovalRequired()` in `approval.ts`): The Block Kit card must be posted in-thread. Verify `thread_ts` is passed.

**No config option** — this is enforced behavior. The `resolveThreadTs()` function already does the right thing. The enforcement is a code audit and adding a safety check:

```typescript
// In outbound.ts, after resolving threadTs:
const threadTs = resolveThreadTs(envelope);

// Safety: if this is a channel message and we don't have threadTs,
// log a warning. The message will still be sent (Slack creates a new thread),
// but this indicates a missing platformData field upstream.
if (isGroupChannel(channelId) && !threadTs) {
  logger.warn(`outbound: no threadTs for channel message in ${channelId} — will create new thread`);
}
```

Where `isGroupChannel()` is imported from `inbound.ts` (or extracted to a shared helper if not already exported).

**Files modified:** `outbound.ts`, `stream.ts` (verification), `approval.ts` (verification). Potentially `inbound.ts` (export `isGroupChannel`).

---

### Improvement 8: Channel-Specific Overrides

**Problem:** Can't disable the bot in specific channels or set channel-specific respond modes.

**New config field:**

```typescript
// In SlackAdapterConfigSchema
channelOverrides: z.record(
  z.string(),
  z.object({
    enabled: z.boolean().optional(),
    respondMode: z.enum(['always', 'mention-only', 'thread-aware']).optional(),
  })
).default({}),
```

**Implementation:** Create a utility function and use it in the inbound handler:

```typescript
// In inbound.ts or a new slack-config.ts utility
export type RespondMode = 'always' | 'mention-only' | 'thread-aware';

export interface ChannelOverride {
  enabled?: boolean;
  respondMode?: RespondMode;
}

export interface EffectiveChannelConfig {
  enabled: boolean;
  respondMode: RespondMode;
}

/**
 * Merge channel-specific overrides onto global defaults.
 *
 * @param channelId - The Slack channel ID
 * @param globalRespondMode - The adapter-level respondMode setting
 * @param overrides - Per-channel override map
 */
export function getEffectiveChannelConfig(
  channelId: string,
  globalRespondMode: RespondMode,
  overrides: Record<string, ChannelOverride>
): EffectiveChannelConfig {
  const override = overrides[channelId];
  return {
    enabled: override?.enabled ?? true,
    respondMode: override?.respondMode ?? globalRespondMode,
  };
}
```

This is called in the inbound handler before the respond mode gating logic (shown in Improvement 4).

**New SLACK_MANIFEST configField:**

```typescript
{
  key: 'channelOverrides',
  label: 'Channel Overrides',
  type: 'textarea',
  required: false,
  description: 'Per-channel settings as JSON. Keys are channel IDs, values have optional "enabled" (boolean) and "respondMode" ("always" | "mention-only" | "thread-aware").',
  placeholder: '{"C01ABC": {"respondMode": "always"}, "C02DEF": {"enabled": false}}',
  section: 'Access Control',
}
```

**Files modified:** `relay-adapter-schemas.ts`, `slack-adapter.ts` (manifest), `inbound.ts`

---

### Schema Changes Summary

The complete updated `SlackAdapterConfigSchema`:

```typescript
export const SlackAdapterConfigSchema = z
  .object({
    botToken: z.string().min(1),
    appToken: z.string().min(1),
    signingSecret: z.string().min(1),
    streaming: z.boolean().default(true),
    nativeStreaming: z.boolean().default(true),
    typingIndicator: z.enum(['none', 'reaction']).default('reaction'),
    respondMode: z.enum(['always', 'mention-only', 'thread-aware']).default('thread-aware'),
    dmPolicy: z.enum(['open', 'allowlist']).default('open'),
    dmAllowlist: z.array(z.string()).default([]),
    channelOverrides: z
      .record(
        z.string(),
        z.object({
          enabled: z.boolean().optional(),
          respondMode: z.enum(['always', 'mention-only', 'thread-aware']).optional(),
        })
      )
      .default({}),
  })
  .openapi('SlackAdapterConfig');
```

### Adapter Manifest ConfigFields Additions

New fields added to `SLACK_MANIFEST.configFields` array (after existing fields), grouped in an "Access Control" section:

1. `respondMode` — select with radio-cards (`'always'`, `'mention-only'`, `'thread-aware'`)
2. `dmPolicy` — select with radio-cards (`'open'`, `'allowlist'`)
3. `dmAllowlist` — textarea (shown when dmPolicy = 'allowlist')
4. `channelOverrides` — textarea (JSON format)

New fields added to `SLACK_MANIFEST.setupSteps[0].fields`:

```typescript
fields: [
  'botToken', 'appToken', 'signingSecret',
  'streaming', 'nativeStreaming', 'typingIndicator',
  'respondMode', 'dmPolicy', 'dmAllowlist', 'channelOverrides',
],
```

## User Experience

### For new users

- Bot defaults to `thread-aware` respond mode — only responds in channels when @mentioned, then continues the conversation naturally in the thread
- Hourglass reaction shows by default while the agent processes
- DMs are open to all workspace members by default
- Long responses are split into multiple messages instead of being truncated

### For existing users

- All new config fields have defaults that are backward-compatible **except** `typingIndicator` which changes from `'none'` to `'reaction'`
- Existing configs that explicitly set `typingIndicator: 'none'` are preserved
- No migration needed — Zod defaults handle everything

### For team workspaces

- `respondMode: 'thread-aware'` prevents the bot from flooding channels
- `dmPolicy: 'allowlist'` restricts DM access to specific users
- `channelOverrides` allows per-channel configuration (disable bot in #general, set `'always'` mode in #bot-chat)

## Testing Strategy

### Unit Tests

**`packages/relay/src/adapters/slack/__tests__/thread-tracker.test.ts`** (new):

- `markParticipating()` stores entries correctly
- `isParticipating()` returns true for tracked threads
- `isParticipating()` returns false for unknown threads
- TTL expiration removes stale entries
- LRU eviction removes oldest when at capacity
- `clear()` removes all entries

**`packages/relay/src/adapters/slack/__tests__/inbound.test.ts`** (updated):

- Event dedup: duplicate `event_id` skips processing
- Event dedup: different `event_id` processes normally
- Event dedup: expired entries are cleaned up
- DM allowlist: allowed user processes
- DM allowlist: non-allowed user skips silently
- DM allowlist: open policy processes all DMs
- Respond mode `'always'`: processes all messages
- Respond mode `'mention-only'`: processes @mentions, skips others
- Respond mode `'thread-aware'`: processes DMs always
- Respond mode `'thread-aware'`: processes @mentions in main channel
- Respond mode `'thread-aware'`: skips non-mention in main channel
- Respond mode `'thread-aware'`: processes messages in participating threads
- Respond mode `'thread-aware'`: skips messages in non-participating threads
- Respond mode `'thread-aware'`: processes @mentions in non-participating threads
- Channel override `enabled: false` skips processing
- Channel override `respondMode` overrides global setting

**`packages/relay/src/adapters/slack/__tests__/outbound.test.ts`** (updated):

- Message splitting: long messages produce multiple `chat.postMessage` calls
- Message splitting: chunks respect paragraph boundaries
- Message splitting: code blocks are properly fenced across chunks
- Thread-first: channel messages include `thread_ts`
- Thread-first: DM messages don't require `thread_ts`
- Thread participation: `markParticipating()` called after successful post

**`packages/relay/src/adapters/slack/__tests__/slack-adapter.test.ts`** (updated):

- Auth failure: fatal error codes stop the adapter
- Auth failure: non-fatal errors are recorded but adapter continues
- Config validation: new fields parse correctly with defaults
- Config validation: explicit values override defaults

**`packages/relay/src/lib/__tests__/payload-utils.test.ts`** (updated):

- `splitMessage()`: short text returns single chunk
- `splitMessage()`: splits at paragraph boundary
- `splitMessage()`: splits at line boundary when no paragraph break
- `splitMessage()`: splits at word boundary when no line break
- `splitMessage()`: hard cuts when no word boundary
- `splitMessage()`: closes and reopens code fences at split points
- `splitMessage()`: handles multiple code blocks
- `splitMessage()`: respects custom maxLen parameter
- `splitMessage()`: empty string returns single empty chunk

**`packages/relay/src/adapters/telegram/__tests__/`** (verified):

- Existing Telegram tests continue to pass after `splitMessage()` import change
- No behavioral change — same function, different import path

### Integration Tests

No new integration tests required — all improvements are in-process logic. Existing adapter integration tests (if any) should continue to pass since all new config fields have backward-compatible defaults.

## Performance Considerations

- **Event dedup LRU Set**: O(1) lookup, 500 entries max, negligible memory (~50 KB)
- **ThreadParticipationTracker**: O(1) lookup, 1000 entries max, negligible memory (~100 KB)
- **Message splitting**: O(n) where n is message length, only runs for messages > 3500 chars. `countUnmatchedFences()` is O(n) but only runs at split boundaries.
- **Rate-limited chunk posting**: 1.1s delay between chunks means a 4-chunk message takes ~3.3s extra. This is intentional to respect Slack's Tier 3 rate limit.
- **No new API calls**: All improvements are in-process logic. Event dedup, respond mode gating, and DM allowlist all reduce API calls by filtering early.

## Security Considerations

- **DM allowlist**: Silent ignore for non-allowlisted users (no rejection message) prevents information disclosure about the bot's access control configuration
- **Auth failure handling**: Fast-fails on token revocation prevent the bot from running in a degraded state
- **Event dedup**: Prevents duplicate agent invocations which could waste API credits
- **Channel overrides**: `enabled: false` provides a kill switch for specific channels

## Documentation

- Update `contributing/relay-adapters.md` with new config fields and their semantics
- Update `docs/relay-messaging.mdx` with respond mode and DM policy documentation
- Add inline code comments explaining the respond mode gating flow

## Implementation Phases

### Phase 1: Foundation

1. **Shared utilities**: Extract `splitMessage()` to `payload-utils.ts`, refactor Telegram import
2. **ThreadParticipationTracker**: Create `thread-tracker.ts` with full test coverage
3. **Schema changes**: Add new fields to `SlackAdapterConfigSchema` and update types
4. **Typing indicator default**: Change default from `'none'` to `'reaction'`

### Phase 2: Core Features

5. **Event deduplication**: Add dedup logic to `inbound.ts`, pass `event_id` from `slack-adapter.ts`
6. **Auth failure handling**: Add fatal error set and update `app.error()` handler
7. **Respond mode gating**: Add respond mode logic to `inbound.ts`, wire up `ThreadParticipationTracker`
8. **DM access control**: Add DM policy check to `inbound.ts`

### Phase 3: Integration

9. **Slack message splitting**: Replace `truncateText()` with `splitMessage()` in `outbound.ts`
10. **Thread-first enforcement**: Audit and verify all outbound code paths, add safety warning
11. **Channel overrides**: Add `getEffectiveChannelConfig()` and wire into inbound handler
12. **Outbound participation tracking**: Mark thread participation after successful posts

### Phase 4: Polish

13. **Manifest updates**: Add new configFields to `SLACK_MANIFEST` with sections, descriptions, help markdown
14. **Test coverage**: Write/update all test files
15. **Documentation**: Update relay-adapters.md and relay-messaging.mdx

## Open Questions

1. ~~**Default respond mode**~~ (RESOLVED)
   **Answer:** `thread-aware` — OpenClaw's #1 missing feature

2. ~~**Default DM policy**~~ (RESOLVED)
   **Answer:** `open` — DorkOS is a developer tool, typically solo workspace

3. ~~**Message splitting location**~~ (RESOLVED)
   **Answer:** Shared utility in `payload-utils.ts` (DRY)

4. ~~**Thread-first configurable?**~~ (RESOLVED)
   **Answer:** Enforced, no config option (less is more)

## Related ADRs

- ADR-0043: Agent Storage (file-first write-through pattern)
- ADR decisions in `contributing/adapter-catalog.md` (multiInstance rule — all state must be instance-scoped)

## References

- [bolt-js Issue #2188](https://github.com/slackapi/bolt-js/issues/2188) — Duplicate events during Socket Mode WebSocket reconnection
- [OpenClaw Issue #30270](https://github.com/openclaw/openclaw/issues/30270) — Thread-aware mention gating (most requested feature)
- [Slack API: Rate Limits](https://api.slack.com/docs/rate-limits) — Tier 3 rate limits for chat.postMessage
- [Slack API: Socket Mode](https://api.slack.com/apis/connections/socket) — Socket Mode documentation
- `contributing/relay-adapters.md` — Adapter development guide
- `contributing/adapter-catalog.md` — Adapter catalog system and multiInstance rules
- `research/20260322_openclaw_slack_integration_analysis.md` — OpenClaw Slack integration analysis
- `research/20260322_slack_adapter_improvements_best_practices.md` — Improvement research
