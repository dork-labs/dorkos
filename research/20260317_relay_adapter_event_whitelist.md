---
title: "Relay Adapter Event Whitelist — Filtering, Platform APIs, Streaming Patterns"
date: 2026-03-17
type: external-best-practices
status: active
tags: [relay, adapter, slack, telegram, streaming, event-filtering, whitelist, typescript, discriminated-union]
feature_slug: relay-adapter-event-whitelist
searches_performed: 7
sources_count: 24
---

# Relay Adapter Event Whitelist — Filtering, Platform APIs, Streaming Patterns

## Research Summary

The whitelist approach is definitively the correct direction for relay adapter event filtering. The existing `SILENT_EVENT_TYPES` blacklist in `packages/relay/src/lib/payload-utils.ts` is the root cause of raw JSON leaking into Slack/Telegram whenever the Claude Agent SDK introduces new event types. The fix requires flipping the logic: adapters should handle exactly the event types they understand (`text_delta`, `done`, `error`) and silently discard everything else. This aligns with the TypeScript exhaustiveness pattern using a `never`-based fallthrough default. Additionally, two major platform developments in 2025-2026 materially change the streaming delivery story: Slack released a native streaming API (`chat.startStream`/`appendStream`/`stopStream`) in October 2025, and Telegram released `sendMessageDraft` to all bots in March 2026 — both enabling first-class streaming without the edit-in-place workarounds currently in use.

## Key Findings

### 1. Whitelist vs Blacklist for Forward-Compatible Event Filtering

**The blacklist pattern is fundamentally broken for open event systems.**

The current code in `payload-utils.ts` (lines 53–65) uses `SILENT_EVENT_TYPES`, a `Set` of known-to-be-silent event types. When the SDK adds new event types — `thinking_delta`, `system_status`, `tool_progress`, `subagent_started`, `hook_started`, `prompt_suggestion`, `presence_update`, `rate_limit`, `compact_boundary`, etc. — they are not in the set, so they fall through to the standard payload path, which JSON-serializes the whole event and sends it as a raw message.

**The whitelist (allowlist) pattern:**
- Default: **drop**. If the event type is not explicitly handled, silently skip it.
- Explicit: only `text_delta`, `done`, and `error` warrant action from relay adapters.
- All other event types — whether known-but-silent or entirely new and unknown — are dropped by default.

**Security/systems analogy:** The whitelist approach is "fail-closed" — unknown events are silently discarded. The blacklist approach is "fail-open" — unknown events pass through, causing exactly the leakage seen in production. Every major security framework (firewalls, API gateways, CSP) uses whitelists for this exact reason.

**Concretely, the current Telegram outbound logic:**
```typescript
// CURRENT (blacklist — broken)
if (SILENT_EVENT_TYPES.has(eventType)) {
  return { success: true, durationMs: ... };
}
// Falls through to: sendAndTrack(bot, chatId, JSON.stringify(payload))
// This sends raw JSON for any event type not in SILENT_EVENT_TYPES
```

**Should become:**
```typescript
// PROPOSED (whitelist — forward-compatible)
// All handled cases are explicit above this point:
// - text_delta: accumulate
// - error: flush + error text
// - done: flush
// Everything else: silently drop
return { success: true, durationMs: Date.now() - startTime };
// No fallthrough to standard payload path for stream events
```

The key structural change: the final `else` / fallthrough path in the StreamEvent branch must be a **silent drop**, not a call to `extractPayloadContent()` + `sendAndTrack()`.

### 2. TypeScript Exhaustiveness Patterns for Event Handling

**The `never`-based exhaustive check is the right tool for closed event unions.**

When the `StreamEvent` type from `@dorkos/shared` is a discriminated union (i.e., its `type` field is a union of string literals), TypeScript can enforce exhaustive handling at compile time:

```typescript
type StreamEventType =
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_call_start'
  | 'tool_call_delta'
  | 'tool_call_end'
  | 'tool_result'
  | 'tool_progress'
  | 'error'
  | 'done'
  | 'system_status'
  | 'compact_boundary'
  | 'subagent_started'
  | 'subagent_progress'
  | 'subagent_done'
  | 'hook_started'
  | 'hook_progress'
  | 'hook_response'
  | 'approval_required'
  | 'question_prompt'
  | 'prompt_suggestion'
  | 'presence_update'
  | 'rate_limit'
  | 'session_status'
  | 'task_update';

function assertNever(x: never): never {
  throw new Error(`Unhandled event type: ${String(x)}`);
}
```

**The correct adapter handler pattern using exhaustiveness:**
```typescript
function handleStreamEvent(eventType: StreamEventType, ...): DeliveryResult | null {
  switch (eventType) {
    case 'text_delta':
      return handleTextDelta(...);
    case 'error':
      return handleError(...);
    case 'done':
      return handleDone(...);
    default:
      // All other known types: silently drop
      // If a new type is added to the union and not handled here,
      // TypeScript will emit a compile error (unreachable `assertNever`)
      return null; // caller returns success: true, durationMs
  }
}
```

**However: for open/external event types, a different approach is needed.**

The Claude Agent SDK types are not fully controlled by DorkOS. When the SDK adds new event types, they arrive as unknown strings. In that case, the `detectStreamEventType()` function already returns a `string | null` — and the adapter must treat any string it doesn't explicitly handle as "drop". The TypeScript exhaustiveness check applies to the _known union_ only.

**Practical recommendation:** Implement both layers:
1. A typed enum/union of all _currently known_ event types (for compile-time safety within the known set)
2. A default `return null` (drop) for any event type that falls through, regardless of whether it's known-and-silent or unknown-and-new

This eliminates the need for `SILENT_EVENT_TYPES` entirely. The set of "things we understand" (text_delta, done, error) is the whitelist. Everything else is dropped.

### 3. Slack Bot Streaming — Native API (October 2025)

**Slack released a native streaming API in October 2025 that eliminates the need for the `chat.update` edit-in-place workaround.**

The three new methods:
- `chat.startStream` — creates a new streaming message placeholder
- `chat.appendStream` — appends text to the stream (token-by-token)
- `chat.stopStream` — finalizes the stream

The `@slack/bolt` v4 SDK provides a `client.chat_stream()` / `streamer.append()` / `streamer.stop()` helper utility.

**Why this matters for DorkOS:**
- The existing `chat.update` approach is throttled to approximately 50 edits/minute across all conversations — this limit is hit quickly when streaming AI responses
- `chat.appendStream` is specifically designed for this use case and has favorable rate limits (details in Slack's streaming API docs)
- Native streaming avoids the flickering/full-replace behavior of `chat.update` — Slack renders the appended text smoothly without re-sending the full message

**Migration path for the Slack adapter:**
```typescript
// Current: chat.postMessage + chat.update on throttle
//   → streams the full accumulated text on each update tick

// Proposed: chat.startStream + chat.appendStream on each text_delta + chat.stopStream on done
//   → native streaming, append-only, lower rate limit impact
```

**Caveat:** The native streaming API requires the bot to have the `chat:write` scope and may require `@slack/bolt` v4.x or the lower-level `@slack/web-api` with the `streaming` feature flag. Verify exact scope requirements before adopting. If the current `chat.update` approach is working reliably, migration to the native streaming API is a polish upgrade, not an urgent correctness fix.

**Rate limit context (for both approaches):**
- `chat.postMessage`: 1 message/second per channel (workspace burst cap)
- `chat.update`: ~50 edits/minute across all conversations (this is the bottleneck)
- `chat.appendStream`: designed for high-frequency append, no published hard limit (but respect platform etiquette)
- Socket Mode connection: 10 max per app (not a concern for single-tenant)

### 4. Telegram Streaming — sendMessageDraft (Bot API 9.5, March 2026)

**Telegram released `sendMessageDraft` to all bots on March 1, 2026 (Bot API 9.5).**

Previously (Bot API 9.3, December 2025): method existed but was restricted. As of Bot API 9.5, all bots can use it.

**Behavior:**
- In **private chats (DMs)**: `sendMessageDraft` streams a "typing preview" bubble in real-time — the recipient sees the AI response appearing character by character, like ChatGPT. This is a native Telegram UX, not a workaround.
- In **groups/topics**: `sendMessage` + `editMessageText` is still the approach (streaming draft only works natively in DMs). The current buffer-and-flush approach in `telegram/outbound.ts` is correct for group contexts.

**Current DorkOS Telegram adapter behavior:**
- Buffers all `text_delta` events in `responseBuffers` (per chatId)
- Flushes the complete buffer on `done` as a single `sendMessage` call
- This is correct for both DMs and groups with the old API

**With sendMessageDraft available:**
- DMs: Call `sendMessageDraft(chatId, text)` for each `text_delta` chunk
- Groups: Keep the existing buffer-and-flush approach
- This gives DM users the native streaming UX while groups get the single-message flush

**grammY support:** The `grammy` package (used by DorkOS's Telegram adapter) tracks the Telegram Bot API very closely (daily updates). Check `grammy.dev` for current method availability; `bot.api.sendMessageDraft(chatId, text)` or `ctx.sendMessageDraft(text)` should be available.

**Rate limit consideration:** Telegram's 1 msg/sec per chat limit still applies, but `sendMessageDraft` is designed for high-frequency updates. Avoid calling it on every `text_delta` chunk at full speed — batch or throttle to a reasonable cadence (e.g., 4-5 times per second) to stay within limits and provide smooth UX without API abuse.

### 5. Adapter Pattern Best Practices — Shared Logic vs Platform-Specific Rendering

**Current architecture is correct: shared `payload-utils.ts` + per-platform outbound modules.**

The pattern of centralizing event detection and extraction in `lib/payload-utils.ts` while keeping platform-specific message formatting in `adapters/telegram/outbound.ts` and `adapters/slack/outbound.ts` is the right separation. The whitelist fix should be implemented in each adapter's outbound module, not in the shared utility.

**Why not in the shared utility:** `SILENT_EVENT_TYPES` should be _deleted_, not moved. The concept of "silent types" is the wrong model. The right model is that each adapter only acts on the events it understands.

**Adapter pattern for the `deliver()` method:**

```typescript
// Recommended adapter deliver() structure (whitelist model):
async function deliverMessage(opts: ...): Promise<DeliveryResult> {
  // 1. Echo prevention (early return, platform-specific)
  if (envelope.from.startsWith(SUBJECT_PREFIX)) return success();

  // 2. Bot guard
  if (!bot) return failure('not started');

  // 3. Chat/channel ID extraction
  const chatId = extractId(subject);
  if (!chatId) return failure('cannot extract ID');

  // 4. StreamEvent detection
  const eventType = detectStreamEventType(envelope.payload);

  // 5. Whitelist handler — ONLY these three types cause delivery
  if (eventType !== null) {
    if (eventType === 'text_delta') return handleTextDelta(...);
    if (eventType === 'error')     return handleError(...);
    if (eventType === 'done')      return handleDone(...);
    // Any other eventType — known or unknown — silently drop
    return success(); // <-- This is the key fix
  }

  // 6. Standard payload (non-StreamEvent) — delivers normally
  return sendStandardMessage(...);
}
```

**Testing for the whitelist:** Each adapter should have a test that verifies unknown event types are silently dropped:

```typescript
it('silently drops unknown event types', async () => {
  const envelope = createMockEnvelope({
    payload: { type: 'new_future_event_type_xyz', data: {} },
  });
  const result = await adapter.deliver(subject, envelope);
  expect(result.success).toBe(true);
  expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
});

it('silently drops known-but-silent event types (thinking_delta)', async () => {
  const envelope = createMockEnvelope({
    payload: { type: 'thinking_delta', data: { thinking: 'internal thoughts' } },
  });
  const result = await adapter.deliver(subject, envelope);
  expect(result.success).toBe(true);
  expect(mockBot.api.sendMessage).not.toHaveBeenCalled();
});
```

### 6. Streaming AI Response Patterns — Batching and Edit-in-Place

**Token-by-token delivery is too chatty for platform APIs. Batching/throttling is required.**

The current Slack adapter correctly throttles `chat.update` via `STREAM_UPDATE_INTERVAL_MS = 1_000` (1-second minimum between updates). The Telegram adapter uses the simpler buffer-and-flush model (single send on `done`).

**Batching strategies ranked by user experience quality:**

| Strategy | UX | API Cost | Complexity |
|---|---|---|---|
| **Buffer-and-flush** (current Telegram) | Low — user sees nothing until complete | Lowest — 1 call | Lowest |
| **Throttled edit-in-place** (current Slack, `chat.update`) | Medium — visible progress at 1-sec intervals | Medium — N edits/min | Medium |
| **Native streaming** (Slack `appendStream`, Telegram `sendMessageDraft`) | High — real-time, smooth, native UX | Designed for high-freq | Low (SDK helper) |

**For the whitelist fix specifically:** The batching/streaming strategy does not change with the whitelist. The fix is orthogonal — it only changes _which events trigger delivery actions_. The accumulation buffer, throttle timer, and flush-on-done logic all stay the same.

**General recommendation for future-proofing the Telegram adapter:**
- Keep buffer-and-flush for groups (correct, safe)
- Add `sendMessageDraft` for DMs behind a feature flag initially (e.g., `config.streaming: true`)
- This mirrors the Slack adapter's existing `streaming: boolean` config field

## Detailed Analysis

### The Root Cause in Code

In `packages/relay/src/lib/payload-utils.ts`, `SILENT_EVENT_TYPES` is used in both adapters:

**Telegram (`adapters/telegram/outbound.ts` lines 144-147):**
```typescript
if (SILENT_EVENT_TYPES.has(eventType)) {
  return { success: true, durationMs: Date.now() - startTime };
}
// Falls through to standard payload path — RAW JSON SENT HERE
```

**Slack (`adapters/slack/outbound.ts` lines 594-596):**
```typescript
if (SILENT_EVENT_TYPES.has(eventType)) {
  return { success: true, durationMs: Date.now() - startTime };
}
// Falls through to standard payload path — RAW JSON SENT HERE
```

The set currently contains:
```
session_status, tool_call_start, tool_call_delta, tool_call_end,
tool_result, approval_required, question_prompt, task_update,
relay_receipt, message_delivered, relay_message
```

Event types NOT in the set (as of today, that would cause leakage):
- `thinking_delta` — extended thinking content
- `system_status` — system-level status updates
- `tool_progress` — incremental tool progress
- `compact_boundary` — context compaction boundary
- `subagent_started`, `subagent_progress`, `subagent_done` — subagent lifecycle
- `hook_started`, `hook_progress`, `hook_response` — hook lifecycle
- `prompt_suggestion` — prompt suggestions from the model
- `presence_update` — presence/activity signals
- `rate_limit` — rate limit notifications
- Any future SDK event type

### The Fix — Minimal Code Change

**Option A: Delete the SILENT_EVENT_TYPES export and change the fallthrough**

In `payload-utils.ts`:
```typescript
// DELETE the SILENT_EVENT_TYPES export entirely
// It is now the wrong model
```

In `telegram/outbound.ts` — replace the final branch:
```typescript
// BEFORE:
if (SILENT_EVENT_TYPES.has(eventType)) {
  return { success: true, durationMs: Date.now() - startTime };
}
// (implicit fallthrough to standard payload path)

// AFTER:
// All unrecognized StreamEvent types are silently dropped (whitelist model)
return { success: true, durationMs: Date.now() - startTime };
```

In `slack/outbound.ts` — same change in the same location.

This is a 2-line change in each outbound file (delete the `if (SILENT_EVENT_TYPES.has(...))` guard and keep the `return` that was inside it), plus deleting the export from `payload-utils.ts`.

**Option B: Rename to HANDLED_EVENT_TYPES as an allowlist (more explicit)**

Keep a set in `payload-utils.ts`, but invert the semantics:
```typescript
/** StreamEvent types that relay adapters actively handle. All others are dropped. */
export const HANDLED_STREAM_EVENT_TYPES = new Set([
  'text_delta',
  'done',
  'error',
] as const);
```

Then in adapters:
```typescript
// Early exit for events we don't handle
if (!HANDLED_STREAM_EVENT_TYPES.has(eventType)) {
  return { success: true, durationMs: Date.now() - startTime };
}
// Only text_delta, done, error reach here
```

**Option A (delete SILENT_EVENT_TYPES) is recommended** because:
- The concept of a "silent" set is the wrong mental model and should not persist in the codebase
- The whitelist is implicitly encoded in the three explicit `if` checks already present in each adapter's stream handler
- Removing `SILENT_EVENT_TYPES` forces future adapter authors to consciously choose what to handle vs drop
- Less exported surface area

### Tests to Update

When `SILENT_EVENT_TYPES` is deleted, the following tests need updating:

1. `packages/relay/src/lib/__tests__/payload-utils.test.ts` — delete the `SILENT_EVENT_TYPES` describe block (lines 175–188 approximately)
2. `packages/relay/src/adapters/slack/__tests__/outbound.test.ts` — remove the `SILENT_EVENT_TYPES` import and mock (line 64)

Add new tests in each adapter's outbound test:
```typescript
describe('event whitelist — unknown events are silently dropped', () => {
  it.each([
    'thinking_delta',
    'system_status',
    'tool_progress',
    'compact_boundary',
    'subagent_started',
    'hook_started',
    'prompt_suggestion',
    'presence_update',
    'rate_limit',
    'some_future_event_xyz',
  ])('silently drops %s', async (eventType) => {
    const result = await deliverMessage({
      ...baseOpts,
      envelope: createMockEnvelope({ payload: { type: eventType, data: {} } }),
    });
    expect(result.success).toBe(true);
    // Verify no external API call was made
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
```

### Adapter Pattern Best Practices — Broader Structural Notes

**Base class (BaseRelayAdapter) is the right foundation.** Both Telegram and Slack adapters already extend it or follow its patterns. The compliance suite in `@dorkos/relay/testing` validates the contract.

**Splitting inbound/outbound into separate modules** (as the Slack and Telegram adapters already do) is the correct pattern. Each module has a single responsibility: inbound normalizes external platform events into relay envelopes; outbound converts relay envelopes back to platform messages.

**The `AdapterOutboundCallbacks` interface** cleanly separates delivery side effects (trackOutbound, recordError) from the delivery logic itself. Keep this pattern for any new adapters.

**For testability**, mock at the `Bot` / `WebClient` level (not the grammy/bolt library level) so tests exercise the actual delivery logic. The `vi.fn()` stub on `bot.api.sendMessage` pattern in `telegram/__tests__/` is the right approach.

## Sources & Evidence

- `packages/relay/src/lib/payload-utils.ts` — `SILENT_EVENT_TYPES` definition, lines 53–65
- `packages/relay/src/adapters/telegram/outbound.ts` — blacklist usage, line 145
- `packages/relay/src/adapters/slack/outbound.ts` — blacklist usage, line 594
- [New features designed for Slack apps sending AI responses | Slack Developer Docs](https://docs.slack.dev/changelog/2025/10/7/chat-streaming/) (Oct 7, 2025)
- [Rate limits | Slack Developer Docs](https://docs.slack.dev/apis/web-api/rate-limits/) — ~50 edits/min for `chat.update`
- [Slack - Support of LLM streaming · bolt-js Issue #2073](https://github.com/slackapi/bolt-js/issues/2073) — community tracking issue for native streaming
- [AI in Slack apps overview | Slack Developer Docs](https://docs.slack.dev/ai/) — new streaming API context
- [Telegram Bot API — sendMessageDraft](https://core.telegram.org/bots/api#sendmessagedraft) — available to all bots as of Bot API 9.5 (March 1, 2026)
- [Telegram Bot API 9.5 Full Streaming for All Bots — AIBase](https://www.aibase.com/news/25881) — announcement coverage
- [OpenClaw Telegram streaming issue #31061](https://github.com/openclaw/openclaw/issues/31061) — real-world tracking of sendMessageDraft adoption
- [Discriminated Unions and Exhaustiveness Checking in TypeScript — FullStory](https://www.fullstory.com/blog/discriminated-unions-and-exhaustiveness-checking-in-typescript/)
- [Exhaustive Switch Expressions in TypeScript — replo.computer](https://replo.computer/posts/exhaustive-switch)
- [Application Whitelisting vs Blacklisting — ColorTokens](https://colortokens.com/blogs/application-whitelisting-application-blacklisting-pros-cons/) — whitelist = fail-closed (correct security posture)
- Prior DorkOS research: `20260227_slack_vs_telegram_relay_adapter.md`
- Prior DorkOS research: `20260224_relay_external_adapters.md`
- Prior DorkOS research: `20260314_relay_adapter_streaming_fixes.md`
- Prior DorkOS research: `20260313_slack_bot_adapter_best_practices.md`
- `contributing/relay-adapters.md` — full adapter architecture documentation

## Research Gaps & Limitations

- Exact rate limits for `chat.startStream`/`appendStream` were not published in the available documentation. The Slack changelog references the methods but defers to the full API reference.
- grammY's exact support status for `sendMessageDraft` (Bot API 9.5) was not verified directly — the package tracks the Bot API daily, so support is expected but should be confirmed before implementation.
- Whether `chat.appendStream` in Slack requires an additional OAuth scope beyond `chat:write` was not determined from available sources.
- The `thinking_delta` event type carries sensitive internal model reasoning. Whether it is appropriate to route any portion of it to external platforms (even in a summarized form) was not evaluated — assume it should always be dropped.

## Contradictions & Disputes

- **sendMessageDraft for groups:** The Telegram documentation and third-party sources agree that `sendMessageDraft` only works natively in private chats/DMs as of Bot API 9.5. Some sources suggest group streaming support may follow, but the current recommendation is: use `sendMessageDraft` in DMs, buffer-and-flush in groups.
- **Slack chat.update vs appendStream:** The `chat.update` approach in the current DorkOS Slack adapter is functional and tested. Migrating to `appendStream` provides better UX but risks introducing new bugs (different SDK call, different threading model). Treat this as an enhancement, not a bug fix. The whitelist fix is independent and should ship first.
- **Deleting SILENT_EVENT_TYPES vs renaming to HANDLED_STREAM_EVENT_TYPES:** Both options are defensible. Deletion is cleaner (the concept is wrong); renaming makes the whitelist explicit and self-documenting. Either works; deletion is the recommendation but the team may prefer the explicitness of a named set.

## Search Methodology

- Searches performed: 7 (3 web searches + 4 targeted web fetches)
- Most productive search terms: "streaming AI response Slack bot edit-in-place rate limiting batching 2025", "Telegram bot streaming AI response sendMessageDraft 2025", "TypeScript discriminated union exhaustive switch whitelist event filtering"
- Primary information sources: Slack developer docs (docs.slack.dev), Telegram Bot API docs (core.telegram.org), DorkOS codebase, prior DorkOS research files
- Codebase analysis was the primary input — the root cause and fix were fully visible in `payload-utils.ts`, `telegram/outbound.ts`, and `slack/outbound.ts`
