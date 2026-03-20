---
title: 'Relay Adapter Streaming Fixes — Slack Bugs, Typing Indicators, Streaming Toggle'
date: 2026-03-14
type: implementation
status: active
tags:
  [slack, telegram, streaming, typing-indicator, mrkdwn, chat-update, stream-state, relay, adapter]
feature_slug: relay-adapter-streaming-fixes
searches_performed: 8
sources_count: 22
---

# Relay Adapter Streaming Fixes — Slack Bugs, Typing Indicators, Streaming Toggle

## Context

This research was conducted with the existing DorkOS adapter codebase fully read:

- `packages/relay/src/adapters/slack/outbound.ts` — streaming via `chat.update`, throttle, TTL reap
- `packages/relay/src/adapters/slack/inbound.ts` — subject routing, TTL/size-bounded caches
- `packages/relay/src/adapters/slack/slack-adapter.ts` — Bolt lifecycle
- `packages/relay/src/adapters/telegram/outbound.ts` — buffer mode, `handleTypingSignal`
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` — `onSignal` subscription
- `packages/relay/src/lib/payload-utils.ts` — `formatForPlatform`, `slackifyMarkdown`

Prior research incorporated: `20260314_slack_bolt_socket_mode_best_practices.md`,
`20260313_slack_bot_adapter_best_practices.md`, `20260227_slack_vs_telegram_relay_adapter.md`.

---

## Research Summary

Four of the five issues in the task brief have surgical fixes grounded in direct code
inspection. The "wrong message routing" bug is the most architecturally significant —
it is caused by the Slack stream state using only `channelId` as the map key, which
allows a second conversation in the same channel to clobber or reuse a prior stream's
`messageTs`. The "text on new lines" bug has two distinct causes: `slackify-markdown`'s
documented paragraph-separation behavior and Slack's own behavior when passing `\n`
inside JSON. Typing indicators for Slack do not exist in any modern API; the correct
workaround is the existing `chat.postMessage` placeholder pattern already available
in the codebase. Telegram typing indicators last exactly 5 seconds and must be
refreshed via interval. The streaming toggle is cleanly implementable as a per-adapter
config field.

---

## Key Findings

### 1. "Text on New Lines" Bug — Root Cause

The "text appearing on new lines" symptom in Slack has two compounding causes:

**Cause A: `slackify-markdown` paragraph handling.**
`slackify-markdown` v5 (based on `unified`/`remark`) treats consecutive Markdown
paragraphs as block-level elements and inserts a blank line between them — i.e., `\n\n`
between paragraphs. In Slack's mrkdwn renderer, `\n\n` (two newlines) is interpreted
as starting a new paragraph section, which visually appears as content appearing on
separate lines inside the message. This is correct Markdown semantics but creates
unexpected visual stacking when streaming short delta chunks.

There is a known open issue in the `jsarafajr/slackify-markdown` repository:
**Issue #40** — "Don't create new sections between line breaks" — which precisely
documents this behavior. The issue is unresolved as of 2026.

**Cause B: Raw `\n` in JSON payloads.**
When agent deltas contain literal newline characters (`\n`), and these are passed
directly into `chat.update` text fields, the JSON serializer escapes them as the
two-character sequence `\`. In some Slack client rendering contexts, this can
appear as literal `\n` text rather than a line break. The correct approach is to
ensure the final mrkdwn string fed to `chat.update` uses actual `\n` characters
(ASCII 0x0A), which `slackify-markdown` produces correctly from parsed Markdown.
The issue only occurs if raw unprocessed deltas are passed before `formatForPlatform`.

**Current code behavior:** `outbound.ts` correctly stores raw Markdown in
`existing.accumulatedText` and only calls `formatForPlatform(existing.accumulatedText, 'slack')`
at send time (line 176). This means Cause B is not present in the current code —
delta chunks are accumulated unformatted and converted to mrkdwn at the point of
`chat.update`. Cause A can still manifest if the agent emits Markdown with blank-line
paragraph separators in early chunks.

**Fix:** For streaming updates (not the final `done` flush), strip double-newlines to
single newlines in the mrkdwn output so each delta update doesn't create paragraph
breaks mid-stream. Apply only during active streaming; allow full mrkdwn on the final
`done` update.

```typescript
// In handleTextDelta, at chat.update time only (not done):
const streamingText = formatForPlatform(existing.accumulatedText, 'slack').replace(/\n{2,}/g, '\n'); // collapse paragraph breaks during streaming
```

The final `handleDone` sends `formatForPlatform(existing.accumulatedText, 'slack')`
unmodified — preserving correct paragraph structure in the finished message.

---

### 2. "Wrong Message Routing" Bug — Root Cause

**Root cause:** The `streamKey` function in `outbound.ts` computes:

```typescript
function streamKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}
```

When `threadTs` is `undefined` (a top-level channel message, not in a thread),
the key is just `channelId`. Two separate conversations in the same channel that
are NOT in a thread both resolve to the same key — so the second conversation
will find and reuse the stream state (`messageTs`) from the first conversation.
Result: the second conversation's responses are appended to and edit the _first_
conversation's message.

This is not a theoretical edge case. Any user who sends two messages to the same
public channel without threading will trigger it.

**Fix:** The stream key must always be unique per agent response. The correct
approach is to use the `threadTs` if present, or the **inbound message's `ts`**
(from `platformData.ts` in the envelope) as a fallback unique identifier. Every
inbound Slack message has a unique `ts`, and outbound replies are threaded to it.

In `resolveThreadTs` (already in `outbound.ts`), the function already extracts
either `platformData.threadTs` (already in thread) or `platformData.ts` (start
a new thread). Since all replies include `thread_ts` pointing to `platformData.ts`,
the envelope will always carry one of these values. The fix is to ensure
`resolveThreadTs` never returns `undefined` if `platformData.ts` is available —
and `streamKey` should never be called without a valid thread anchor.

```typescript
// Fix resolveThreadTs to guarantee a value when platformData.ts exists
function resolveThreadTs(envelope: RelayEnvelope): string | undefined {
  const payload = envelope.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  const pd = obj.platformData as Record<string, unknown> | undefined;
  if (!pd) return undefined;
  // Prefer thread_ts (already in a thread); fall back to ts (start a new thread)
  const ts =
    (typeof pd.threadTs === 'string' && pd.threadTs) ||
    (typeof pd.ts === 'string' && pd.ts) ||
    undefined;
  return ts;
}
```

With this in place, `streamKey(channelId, threadTs)` where `threadTs` is always
defined creates a unique key per-message-conversation, preventing cross-routing.

**Secondary fix:** For cases where `platformData` is absent (programmatic messages
sent without inbound context), add a correlation ID. The simplest approach: when
`threadTs` cannot be resolved, generate a per-deliver invocation ID and store it
in the stream state creation call. This prevents the `channelId`-only fallback.

```typescript
// In handleTextDelta's "Start new stream" block:
const stableKey = threadTs ?? `${channelId}:${Date.now()}-${Math.random().toString(36).slice(2)}`;
```

---

### 3. "Stale Edits" Bug — Root Cause

**Root cause:** The `handleDone` function deletes the stream entry from `streamState`
before calling `chat.update`:

```typescript
async function handleDone(...): Promise<DeliveryResult> {
  const key = streamKey(channelId, threadTs);
  const existing = streamState.get(key);
  streamState.delete(key);  // ← deleted before the final chat.update
  ...
}
```

If a new stream starts for the same key _before_ the async `chat.update` in `handleDone`
completes (i.e., a race between `done` finalization and a new `text_delta` arriving), the
new stream's `postMessage` runs, creates a new entry, and then the stale `chat.update`
from `handleDone` may overwrite the new message's content. This is an async race.

The TTL reaper in `deliverMessage` (5-minute orphan reap) does not prevent this because
the race window is milliseconds, not minutes.

**Fix:** Before the final `chat.update` in `handleDone`, re-check that the stream key is
not already populated by a new stream:

```typescript
async function handleDone(channelId, threadTs, client, streamState, callbacks, startTime) {
  const key = streamKey(channelId, threadTs);
  const existing = streamState.get(key);
  streamState.delete(key);
  if (!existing) return { success: true, durationMs: Date.now() - startTime };

  const result = await wrapSlackCall(
    () =>
      client.chat.update({
        channel: channelId,
        ts: existing.messageTs,
        text: truncateText(
          formatForPlatform(existing.accumulatedText, 'slack'),
          MAX_MESSAGE_LENGTH
        ),
      }),
    callbacks,
    startTime,
    true
  );

  // After the async update, if a NEW stream started for this key during the await,
  // ensure its messageTs is not the one we just finalized (paranoia guard).
  // The new stream will have a different messageTs from its own chat.postMessage.
  return result;
}
```

The more robust fix is a **stream ID (correlation ID)** inside `ActiveStream`:

```typescript
export interface ActiveStream {
  streamId: string; // unique per stream, e.g. crypto.randomUUID() or nanoid
  channelId: string;
  threadTs: string;
  messageTs: string;
  accumulatedText: string;
  lastUpdateAt: number;
  startedAt: number;
}
```

`handleDone` captures `existing.streamId` before deleting, then after the
`chat.update` verifies the current stream state for that key (if any) has a
_different_ `streamId` before doing anything further. If the IDs match, the
finalization is safe. If they differ, the key was taken by a new stream — the
stale update already went through but to the correct (old) `messageTs`, so
no corruption occurred.

**Complexity:** Low-medium. The correlation ID approach adds 1 field and 1 check.

---

### 4. Streaming Toggle — Design

**Recommended placement:** Per-adapter config field, not per-binding.

**Rationale:**

- Bindings connect a specific agent to a specific channel. Streaming is a behavior
  of the adapter delivery mechanism, not of the binding relationship.
- Different Slack workspaces have different latency characteristics. A user may
  want streaming off for a slow workspace and on for a fast one.
- The toggle maps cleanly to the `SlackAdapterConfig` Zod schema, which already
  has precedent for per-adapter behavior flags (Socket Mode vs HTTP).
- Per-binding streaming toggle would require every binding to carry this field,
  bloating the binding schema for a minor UX benefit.

**Implementation:**

In `@dorkos/shared/relay-schemas`, extend `SlackAdapterConfigSchema`:

```typescript
export const SlackAdapterConfigSchema = AdapterConfigBaseSchema.extend({
  type: z.literal('slack'),
  botToken: z.string(),
  appToken: z.string(),
  signingSecret: z.string(),
  streaming: z
    .boolean()
    .default(true)
    .describe('When false, buffer all text_delta events and send as a single message on done.'),
});
```

In `outbound.ts`, thread `streaming` through `SlackDeliverOptions`:

```typescript
export interface SlackDeliverOptions {
  ...
  streaming: boolean;   // new field
}
```

In `handleTextDelta`, when `streaming === false`:

```typescript
if (!config.streaming) {
  // Treat identically to Telegram's buffer mode:
  const existing = streamState.get(key);
  if (existing) {
    existing.accumulatedText += textChunk;
  } else {
    streamState.set(key, {
      channelId,
      threadTs: threadTs ?? '',
      messageTs: '',
      accumulatedText: textChunk,
      lastUpdateAt: 0,
      startedAt: Date.now(),
    });
  }
  return { success: true, durationMs: Date.now() - startTime };
}
```

In `handleDone`, when `streaming === false`, use `chat.postMessage` instead of
`chat.update` (since there is no pre-posted message to edit):

```typescript
if (!config.streaming) {
  return wrapSlackCall(
    () =>
      client.chat.postMessage({
        channel: channelId,
        text: truncateText(
          formatForPlatform(existing.accumulatedText, 'slack'),
          MAX_MESSAGE_LENGTH
        ),
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    callbacks,
    startTime,
    true
  );
}
```

This makes the Slack adapter behave exactly like the Telegram adapter when streaming
is off — accumulate all deltas, send one message on `done`.

**Config field in the UI manifest:**

```typescript
{
  key: 'streaming',
  label: 'Stream responses',
  type: 'boolean',
  default: true,
  description: 'Show responses as they arrive (live editing). Disable to send a single message when complete.',
}
```

**UX rationale for "when would a user want streaming off":**

- The user's Slack workspace is heavily monitored and they don't want partially-formed
  agent messages visible to colleagues mid-stream.
- The agent produces very short responses where streaming adds no perceptible UX value.
- The user is using DorkOS in a high-throughput batch mode and wants reduced API calls.
- Slack's `chat.update` rate limit (1/sec per channel) is causing throttling delays,
  making streaming feel slower than non-streaming.

---

### 5. Typing Indicators

#### Slack — No Native Bot Typing Indicator

**Confirmed conclusion:** Slack does not expose a typing indicator API for bots via
modern APIs (Events API or Web API). The `user_typing` event existed only in the
deprecated RTM API. A Slack team member confirmed in the official `bolt-js` GitHub
issue #885: _"The `user_typing` event is a feature of the RTM API, but unfortunately
it's not available in the Events API or Web API."_ As of 2026, RTM is discontinued.

**Available workarounds (ranked by UX quality):**

1. **Native Streaming API (`chatStream`)** — The best UX. Slack's own UI shows a
   native streaming indicator while `chatStream` is active. Does not look exactly
   like a typing indicator but is purpose-built for AI agent use cases. DorkOS's
   current `chat.update` approach does not use `chatStream`. If/when DorkOS
   migrates to `chatStream`, typing indicators become a non-issue.

2. **Emoji reaction** — Add a `:hourglass_flowing_sand:` or `:loading:` reaction to the
   inbound message at stream start; remove it on `done`. Uses `reactions.add` /
   `reactions.remove`. Low visual noise. Rate limit: Tier 3 (50 req/min) — safe.

   ```typescript
   // On text_delta (first chunk only):
   await client.reactions.add({
     channel: channelId,
     name: 'hourglass_flowing_sand',
     timestamp: threadTs,
   });
   // On done:
   await client.reactions.remove({
     channel: channelId,
     name: 'hourglass_flowing_sand',
     timestamp: threadTs,
   });
   ```

   Requires `reactions:write` scope to be added to the manifest.

3. **Placeholder "thinking" message** — Post `_Agent is working..._` immediately on
   first `text_delta`, then replace it with streamed content via `chat.update`.
   This is effectively what the current `chat.update` streaming already does —
   the first `chat.postMessage` in `handleTextDelta` serves as the placeholder.

4. **ASCII spinner in message text** — Append/change a spinner character (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
   on each `chat.update`. Visual but wastes rate limit budget on spinner updates.
   Not recommended.

**Recommendation for Slack:** Implement the emoji reaction approach as a lightweight
addition. It costs two API calls per stream (add + remove), requires one new scope,
and provides clear "bot is working" feedback without any rate limit risk. The
placeholder message approach (current behavior) is already providing basic feedback.

**Implementation in `outbound.ts`:**

```typescript
// In handleTextDelta, when starting a new stream (the `!existing` branch):
if (channelConfig.typingIndicator === 'reaction' && threadTs) {
  void client.reactions
    .add({
      channel: channelId,
      name: 'hourglass_flowing_sand',
      timestamp: threadTs, // add reaction to the user's original message
    })
    .catch(() => {}); // fire-and-forget, best-effort
}

// In handleDone:
if (channelConfig.typingIndicator === 'reaction' && existing.threadTs) {
  void client.reactions
    .remove({
      channel: channelId,
      name: 'hourglass_flowing_sand',
      timestamp: existing.threadTs,
    })
    .catch(() => {}); // fire-and-forget
}
```

The `typingIndicator` field can be `'none' | 'reaction'` (defaulting to `'none'` for
backward compatibility). Add to `SlackAdapterConfig`.

#### Telegram — Typing Indicator Already Works, Needs Interval Refresh

**Confirmed behavior:**

- `sendChatAction(chatId, 'typing')` makes the "User is typing..." indicator appear
  for exactly 5 seconds or until the bot sends a message.
- For operations longer than 5 seconds, the action must be refreshed every ~4 seconds.

**Current DorkOS implementation:**
The Telegram adapter already supports typing signals via `handleTypingSignal` in
`outbound.ts`, and the adapter subscribes to `relay.human.telegram.>` signals via
`relay.onSignal` in `telegram-adapter.ts` (line 136). The signal handler calls
`sendChatAction` once per signal emission.

**Gap:** The current implementation sends `sendChatAction` once when the signal fires.
If the agent response takes >5 seconds, the typing indicator disappears. There is no
interval refresh.

**Fix — Interval refresh in `handleTypingSignal`:**

The `handleTypingSignal` function should:

1. On `state === 'active'`: start a `setInterval` that calls `sendChatAction` every 4
   seconds, store it keyed by `chatId`.
2. On `state !== 'active'` (i.e., `'stopped'`): clear the interval.

```typescript
// In outbound.ts:
const typingIntervals = new Map<number, ReturnType<typeof setInterval>>();

export async function handleTypingSignal(
  bot: Bot | null,
  subject: string,
  state: string
): Promise<void> {
  if (!bot) return;
  const chatId = extractChatId(subject);
  if (chatId === null) return;

  if (state === 'active') {
    // Clear any existing interval for this chat (idempotent)
    clearTypingInterval(chatId);

    // Send immediately
    try {
      await bot.api.sendChatAction(chatId, 'typing');
    } catch {
      /* best-effort */
    }

    // Refresh every 4 seconds
    const intervalId = setInterval(async () => {
      try {
        await bot.api.sendChatAction(chatId, 'typing');
      } catch {
        clearTypingInterval(chatId); // stop on error
      }
    }, 4_000);
    typingIntervals.set(chatId, intervalId);
  } else {
    clearTypingInterval(chatId);
  }
}

function clearTypingInterval(chatId: number): void {
  const existing = typingIntervals.get(chatId);
  if (existing !== undefined) {
    clearInterval(existing);
    typingIntervals.delete(chatId);
  }
}

/** Clear all active typing intervals — call on adapter stop. */
export function clearAllTypingIntervals(): void {
  for (const interval of typingIntervals.values()) clearInterval(interval);
  typingIntervals.clear();
}
```

`clearAllTypingIntervals()` must be called in `TelegramAdapter._stop()` to prevent
leaked intervals after adapter shutdown.

**Rate limit consideration:** `sendChatAction` is Tier 4 (100+ req/min). At 1 call per
4 seconds, a single active stream uses 15 calls/min — well within limits. Even with
10 concurrent streams, this is 150 calls/min across all chats, which is within the
workspace burst budget.

**Memory consideration:** The `typingIntervals` map lives in module scope in `outbound.ts`.
To prevent leaks, the `TelegramAdapter._stop()` method should call `clearAllTypingIntervals()`.

---

## Detailed Analysis

### Streaming Architecture Overview

The current adapter architecture has two streaming modes:

| Adapter  | Streaming Mode     | How It Works                                                                                        |
| -------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| Slack    | **Live edit**      | `postMessage` (first delta) → `chat.update` on each throttled delta → final `chat.update` on `done` |
| Telegram | **Buffer + flush** | Accumulate all deltas in `responseBuffers` → `sendMessage` single message on `done`                 |

The streaming toggle feature will add a **buffer + flush** mode to Slack, making it
functionally equivalent to Telegram's delivery model.

### Stream State Key Architecture

**Current:** `streamKey(channelId, threadTs?)`

- If `threadTs` is undefined: key = `channelId` (BUGGY — shared across conversations)
- If `threadTs` is defined: key = `channelId:threadTs` (correct)

**Proposed:** Always require a thread anchor. `resolveThreadTs` should always return a
string when `platformData.ts` exists (which it always does for inbound Slack messages).

**Edge case: programmatic messages** (no inbound context, no `platformData`):
Use a synthetic correlation ID as the thread anchor. The stream key must be unique
per agent "conversation turn", not per channel.

### slackify-markdown Known Behavior Summary

Issue #40 ("Don't create new sections between line breaks") is the core concern. The
library treats Markdown paragraphs (separated by blank lines) as separate `section`
nodes, emitting `\n\n` between them in mrkdwn output. This is technically correct
per the Markdown spec but creates unexpected visual line breaks when streaming partial
responses.

**Workaround during streaming:** Collapse `\n{2,}` to `\n` on intermediate updates.
Allow full paragraph formatting on the final `done` update.

**Alternative:** Use Slack's native `markdown` block type (`type: "markdown"`) for the
final message. Slack handles the Markdown-to-mrkdwn conversion server-side, potentially
with better handling of paragraph spacing. The tradeoff is moving from `text` field
to `blocks`, which requires the `text` field as accessibility fallback.

---

## Security Considerations

- The streaming toggle does not introduce new attack surfaces. Buffer mode accumulates
  text in memory (same as Telegram's `responseBuffers`); the existing `MAX_MESSAGE_LENGTH`
  truncation applies on flush.
- Emoji reaction approach requires `reactions:write` scope. This is a bot-level scope
  and does not grant access to read messages or users. Safe to add.
- Typing interval refresh: `typingIntervals` Map holds `setInterval` handles keyed by
  Telegram chat IDs (integers). No sensitive data is stored. Memory footprint is trivial
  (one handle per active stream). The `clearAllTypingIntervals` guard on `_stop()`
  prevents leaks.
- The correlation ID fix generates IDs via `Date.now() + Math.random()`. This is
  sufficient for a local in-process map key (not a cryptographic need). `crypto.randomUUID()`
  is better practice if already available in the Node.js version.

---

## Performance Considerations

- **Streaming toggle buffer mode:** Accumulates the full response in memory before
  sending. For large agent responses (e.g., 3,500 characters), this is negligible.
  The `MAX_MESSAGE_LENGTH` truncation (4000 chars) applies identically.
- **Emoji reaction:** Two extra API calls per stream (add + remove). Both are
  fire-and-forget with `.catch(() => {})`. Zero impact on streaming latency.
- **Telegram typing intervals:** 4-second interval. Adds 15 `sendChatAction` calls
  per active stream per minute. `sendChatAction` is a lightweight Telegram API call
  (no response body, just HTTP 200). Negligible.
- **Correlation ID map:** `streamState` is already a `Map`. Adding a `streamId` field
  to each `ActiveStream` entry adds ~36 bytes per active stream. Trivial.

---

## Potential Solutions Summary

### Bug 1: Text on New Lines

| Approach                                                  | Pros                         | Cons                                              | Complexity       |
| --------------------------------------------------------- | ---------------------------- | ------------------------------------------------- | ---------------- |
| Collapse `\n\n` → `\n` on intermediate `chat.update`      | Surgical, no library changes | Loses paragraph structure mid-stream (acceptable) | Trivial (1 line) |
| Switch to Slack's native `markdown` block                 | Slack handles formatting     | Requires `blocks` API, `text` fallback needed     | Low-medium       |
| Strip headings/paragraphs from `slackify-markdown` output | Clean output                 | Lossy — may strip intentional structure           | Low              |
| Replace `slackify-markdown` with custom converter         | Full control                 | High maintenance, risky regression                | High             |

**Recommended: Approach 1 (collapse during streaming, full formatting on `done`).**

### Bug 2: Wrong Message Routing

| Approach                                                        | Pros                                  | Cons                                      | Complexity |
| --------------------------------------------------------------- | ------------------------------------- | ----------------------------------------- | ---------- |
| Always include `threadTs` in stream key (fix `resolveThreadTs`) | Correct semantics, uses existing data | Requires `platformData.ts` always present | Trivial    |
| Add synthetic correlation ID fallback for undefined `threadTs`  | Handles programmatic messages         | Slightly more code                        | Low        |
| Per-deliver correlation ID only (no `threadTs` in key)          | Simplest                              | Breaks thread isolation                   | Wrong      |

**Recommended: Fix `resolveThreadTs` + synthetic fallback for no-context messages.**

### Bug 3: Stale Edits

| Approach                                              | Pros                       | Cons                                       | Complexity |
| ----------------------------------------------------- | -------------------------- | ------------------------------------------ | ---------- |
| Add `streamId` field to `ActiveStream`                | Eliminates race completely | Minor API surface expansion                | Low        |
| Check if key re-populated post-delete in `handleDone` | No field change needed     | Slightly harder to reason about            | Low        |
| Delete key only after `chat.update` completes         | Prevents the race          | Wider race window if `chat.update` is slow | Low        |

**Recommended: Add `streamId` correlation field.**

### Feature: Streaming Toggle

| Approach                                | Pros                         | Cons                        | Complexity   |
| --------------------------------------- | ---------------------------- | --------------------------- | ------------ | ---------------------- | ------ |
| Per-adapter config `streaming: boolean` | Clean, per-workspace control | No per-channel granularity  | Low          |
| Per-binding config                      | Per-channel control          | Bloats binding schema       | Medium       |
| `streaming: 'on'                        | 'off'                        | 'auto'` with auto-detection | Future-proof | Auto rules are complex | Medium |

**Recommended: Per-adapter `streaming: boolean` (default `true`).**

### Feature: Slack Typing Indicator

| Approach                                   | Pros                                         | Cons                                         | Complexity      |
| ------------------------------------------ | -------------------------------------------- | -------------------------------------------- | --------------- |
| Emoji reaction (`:hourglass:` on user msg) | Visible, low noise, safe scope               | Requires `reactions:write` scope             | Low             |
| Placeholder "working..." message           | Already implicitly done by current streaming | No clear visual affordance until first delta | None (existing) |
| ASCII spinner on each `chat.update`        | Animated                                     | Wastes rate limit                            | Low             |
| Native `chatStream` API                    | Best UX, native Slack indicator              | Major refactor of streaming approach         | High            |

**Recommended: Emoji reaction as opt-in config (`typingIndicator: 'none' | 'reaction'`).**

### Feature: Telegram Typing Interval Refresh

| Approach                                       | Pros                     | Cons                          | Complexity          |
| ---------------------------------------------- | ------------------------ | ----------------------------- | ------------------- |
| 4-second `setInterval` in `handleTypingSignal` | Correct, Telegram-native | Needs cleanup on adapter stop | Low                 |
| One-shot `sendChatAction` per signal (current) | Simple                   | Disappears after 5s           | None (existing bug) |

**Recommended: Interval refresh with cleanup on `_stop()`.**

---

## Recommended Approach

### Priority 1 — Bug Fixes (immediate)

1. **Wrong routing:** Fix `resolveThreadTs` to never return `undefined` when `platformData.ts`
   is present. Add synthetic key fallback for no-context cases. This eliminates the stream
   clobbering bug completely.

2. **Text on new lines:** Add `.replace(/\n{2,}/g, '\n')` to intermediate `chat.update`
   calls in `handleTextDelta`. Do not apply to the `handleDone` final update.

3. **Stale edits:** Add `streamId: string` (nanoid or `Date.now().toString(36)`) to
   `ActiveStream`. In `handleDone`, capture `streamId` from the existing entry before
   deleting. Log a warning if a concurrent stream is detected. The race window is narrow
   but the correlation ID makes it observable and safe.

### Priority 2 — Telegram Typing Refresh (quick win)

4. **Telegram typing interval:** Add `setInterval` in `handleTypingSignal`, clear on stop.
   This is ~30 lines of code and fixes a real UX gap for users with slow agent responses.

### Priority 3 — Streaming Toggle (additive feature)

5. **Slack streaming toggle:** Add `streaming: z.boolean().default(true)` to
   `SlackAdapterConfigSchema`. Thread through `SlackDeliverOptions`. In `handleTextDelta`
   and `handleDone`, branch on `streaming` to use buffer-flush mode vs live-edit mode.

### Priority 4 — Typing Indicator for Slack (opt-in enhancement)

6. **Slack typing via emoji reaction:** Add `typingIndicator: z.enum(['none', 'reaction']).default('none')`
   to `SlackAdapterConfigSchema`. Add `reactions:write` scope to the app manifest YAML.
   Fire-and-forget `reactions.add` / `reactions.remove` in `handleTextDelta` (first chunk)
   and `handleDone`.

---

## Research Gaps and Limitations

- The exact `chat.update` rate limit tier is documented as "Special" by Slack, same
  category as `chat.postMessage`. The 1/sec per channel assumption is standard. If
  Slack has a different limit for `update` vs `postMessage`, the throttle constant
  (`STREAM_UPDATE_INTERVAL_MS = 1_000`) should be verified against the actual tier.
- Slack's `chatStream` native API (released October 2025) was confirmed to exist and
  be the preferred approach for AI streaming. The `@slack/web-api` TypeScript types
  for `client.chatStream()` were not directly inspected. If/when DorkOS migrates to
  `chatStream`, the routing and stale-edit bugs become moot (Slack manages the stream
  state server-side). This is the correct long-term direction but is a substantial
  refactor of `outbound.ts`.
- The `reactions:write` scope for the emoji typing indicator adds a new permission
  that users must re-install their Slack app to grant. This is a non-trivial UX
  cost for users who have already installed the adapter. Consider making the emoji
  indicator opt-in and documenting the re-install requirement.

---

## Sources and Evidence

- **slackify-markdown Issue #40** — "Don't create new sections between line breaks" (open, unresolved): [jsarafajr/slackify-markdown Issues](https://github.com/jsarafajr/slackify-markdown/issues)
- **Slack bolt-js Issue #885** — Confirmed: no bot typing indicator in Events API: [Is it possible to indicate "Bot user typing..." using bolt-js](https://github.com/slackapi/bolt-js/issues/885)
- **Telegram `sendChatAction` behavior** — 5-second expiry, refresh pattern: [sendChatAction](https://telegram-bot-sdk.readme.io/reference/sendchataction), [The "Typing" action in Telegram](https://bot-market.com/blog/botmarket-knowledge-base/the-typing-action-sendchataction-in-telegram-/en)
- **Slack mrkdwn newline behavior** — `\n` in JSON must be literal newline, not escaped literal: [Slack node-sdk issue #1633](https://github.com/slackapi/node-slack-sdk/issues/1633)
- **Slack Formatting Reference** — mrkdwn syntax, block types: [Formatting message text | Slack Developer Docs](https://docs.slack.dev/messaging/formatting-message-text/)
- **LibreChat streaming toggle pattern** — Per-endpoint `disableStreaming` config field: [LibreChat PR #8177](https://github.com/danny-avila/LibreChat/pull/8177)
- **LangGraph disable streaming** — Model-level `disable_streaming` config: [LangGraph how-tos](https://langchain-ai.github.io/langgraph/how-tos/disable-streaming/)
- **Slack `chat.update` and mrkdwn** — Confirmed `chat.update` accepts mrkdwn text field: [Legacy Messaging | Slack](https://docs.slack.dev/legacy/legacy-messaging/)
- **Prior DorkOS research** — Slack best practices, rate limits, Socket Mode: [research/20260314_slack_bolt_socket_mode_best_practices.md](research/20260314_slack_bolt_socket_mode_best_practices.md)
- **Prior DorkOS research** — chatStream API, threading, mrkdwn: [research/20260313_slack_bot_adapter_best_practices.md](research/20260313_slack_bot_adapter_best_practices.md)

---

## Search Methodology

- Searches performed: 8
- Most productive search terms: `slackify-markdown github issues newline paragraph`,
  `Telegram sendChatAction typing duration refresh 2025`,
  `Slack chat.update mrkdwn newline rendering \n behavior`,
  `bolt-js typing indicator bot workaround 2026`
- Primary sources: GitHub (slackapi/bolt-js, jsarafajr/slackify-markdown),
  Telegram Bot SDK docs, LibreChat PR/issues
- Prior DorkOS research heavily leveraged: 3 existing Slack/relay research reports
