---
slug: relay-adapter-event-whitelist
number: 147
created: 2026-03-17
status: specification
---

# Relay Adapter Event Whitelist Overhaul

**Spec:** #147
**Ideation:** [01-ideation.md](./01-ideation.md)
**Research:** [20260317_relay_adapter_event_whitelist.md](../../research/20260317_relay_adapter_event_whitelist.md)

---

## Overview

Relay adapters (Slack, Telegram) leak raw JSON to users when unrecognized SDK event types arrive. The root cause is a blacklist (`SILENT_EVENT_TYPES`) that fails open — unknown events fall through to `extractPayloadContent()` which `JSON.stringify`s them. This spec flips to a whitelist model (adapters only act on events they explicitly handle), upgrades both adapters to native streaming APIs, and fixes the Telegram buffer memory leak.

### Three Phases

| Phase | Scope                                                                                                     | Risk   | Urgency                    |
| ----- | --------------------------------------------------------------------------------------------------------- | ------ | -------------------------- |
| 1     | Whitelist fix — delete `SILENT_EVENT_TYPES`, silent drop fallthrough                                      | Low    | Critical (user-facing bug) |
| 2     | Native streaming APIs — Slack `chat.startStream`/`appendStream`/`stopStream`, Telegram `sendMessageDraft` | Medium | Enhancement                |
| 3     | Telegram buffer TTL reaping + comprehensive test coverage                                                 | Low    | Defensive                  |

---

## Phase 1: Whitelist Fix

### Problem

`payload-utils.ts` exports `SILENT_EVENT_TYPES` (11 entries). Both `slack/outbound.ts:594` and `telegram/outbound.ts:145` check this set. When the SDK adds new event types (14 types were added recently and not included), they fall through to the standard payload path, which calls `extractPayloadContent()` → `JSON.stringify()` → sends raw JSON as a chat message.

### Design

**Delete `SILENT_EVENT_TYPES` entirely.** After the three explicit handlers (`text_delta`, `error`, `done`), return `{ success: true }` immediately for all other recognized stream events. This makes the system forward-compatible: new SDK event types are silently ignored until an adapter explicitly handles them.

### Changes

#### `packages/relay/src/lib/payload-utils.ts`

Delete the `SILENT_EVENT_TYPES` export (lines 52-65):

```typescript
// DELETE:
/** Known StreamEvent types that carry no user-visible text. */
export const SILENT_EVENT_TYPES = new Set([...]);
```

#### `packages/relay/src/adapters/slack/outbound.ts`

Remove `SILENT_EVENT_TYPES` import. Replace lines 592-596:

```typescript
// BEFORE:
    // Silent events: skip without sending anything
    if (SILENT_EVENT_TYPES.has(eventType)) {
      return { success: true, durationMs: Date.now() - startTime };
    }
  }

  // --- Standard payload (non-StreamEvent) ---

// AFTER:
    // All other StreamEvent types: silently drop (whitelist model).
    // Only text_delta, error, and done warrant delivery actions.
    return { success: true, durationMs: Date.now() - startTime };
  }

  // --- Standard payload (non-StreamEvent) ---
```

The key change: the closing `}` of `if (eventType)` now has an unconditional `return` before it, preventing fallthrough to the standard payload path for any stream event.

#### `packages/relay/src/adapters/telegram/outbound.ts`

Same pattern. Remove `SILENT_EVENT_TYPES` import. Replace lines 144-147:

```typescript
// BEFORE:
// All other StreamEvent types: silently skip
if (SILENT_EVENT_TYPES.has(eventType)) {
  return { success: true, durationMs: Date.now() - startTime };
}

// AFTER:
// All other StreamEvent types: silently drop (whitelist model).
// Only text_delta, error, and done warrant delivery actions.
return { success: true, durationMs: Date.now() - startTime };
```

### Test Changes (Phase 1)

#### `packages/relay/src/adapters/slack/__tests__/outbound.test.ts`

1. Remove `SILENT_EVENT_TYPES` from the mock (line 64-76)
2. Replace `describe('silent event types')` with a whitelist test:

```typescript
describe('event whitelist — unknown events silently dropped', () => {
  it.each([
    'thinking_delta',
    'system_status',
    'tool_progress',
    'compact_boundary',
    'subagent_started',
    'subagent_progress',
    'subagent_done',
    'hook_started',
    'hook_progress',
    'hook_response',
    'prompt_suggestion',
    'presence_update',
    'rate_limit',
    'session_status',
    'tool_call_start',
    'tool_call_delta',
    'tool_call_end',
    'tool_result',
    'approval_required',
    'question_prompt',
    'some_future_event_xyz',
  ])('silently drops %s', async (eventType) => {
    const envelope = createEnvelope('relay.human.slack.D123', {
      type: eventType,
      data: { text: 'internal data' },
    });
    const result = await deliver(
      'relay.human.slack.D123',
      envelope,
      client,
      streamState,
      callbacks
    );
    expect(result.success).toBe(true);
    expect(mockPostMessage).not.toHaveBeenCalled();
    expect(mockChatUpdate).not.toHaveBeenCalled();
  });
});
```

#### `packages/relay/src/adapters/telegram/__tests__/outbound.test.ts`

Add a new `describe` block for `deliverMessage` with equivalent whitelist tests. This file currently only tests typing indicators — add delivery tests covering:

1. Standard payload delivery
2. StreamEvent buffering (text_delta → done)
3. Error handling
4. Whitelist — unknown events silently dropped (same `it.each` pattern)

#### `packages/relay/src/lib/__tests__/payload-utils.test.ts`

Remove any `SILENT_EVENT_TYPES` test block (if present). No replacement needed — the concept is deleted.

---

## Phase 2: Native Streaming APIs

### Slack: `chat.startStream` / `appendStream` / `stopStream`

Slack released a native streaming API in October 2025 that replaces the `chat.update` edit-in-place workaround. Benefits: better rate limits (chat.update limited to ~50 edits/min), smoother UX (append-only, no flickering), purpose-built for AI streaming.

**Constraint:** Slack's streaming API requires messages to be in threads. All DorkOS Slack adapter responses already use `thread_ts` (threaded under the user's original message), so this constraint is already satisfied for the standard flow.

#### Config

Add a `nativeStreaming` config field to the Slack adapter (alongside existing `streaming`):

```typescript
// In slack-adapter.ts config fields
{
  key: 'nativeStreaming',
  label: 'Native Streaming',
  description: 'Use Slack\'s native streaming API (chat.startStream/appendStream/stopStream). Requires messages in threads.',
  type: 'boolean',
  default: true,
}
```

The existing `streaming` field controls whether text is streamed at all (vs buffer-and-flush). The new `nativeStreaming` field controls which streaming method to use when `streaming` is true:

- `streaming: true, nativeStreaming: true` → Slack native streaming API (new default)
- `streaming: true, nativeStreaming: false` → `chat.update` edit-in-place (legacy)
- `streaming: false` → buffer-and-flush on done (existing)

#### Implementation

In `slack/outbound.ts`, modify `handleTextDelta`:

**When `nativeStreaming` is true:**

- First `text_delta`: Call `client.chat.startStream({ channel, thread_ts })` → returns a `stream_id`. Store in `ActiveStream`.
- Subsequent `text_delta`: Call `client.chat.appendStream({ stream_id, text: textChunk })`. No throttling needed — the API is designed for high-frequency appends.
- `done`: Call `client.chat.stopStream({ stream_id })`.
- `error`: Call `client.chat.appendStream({ stream_id, text: errorSuffix })` then `client.chat.stopStream({ stream_id })`.

**When `nativeStreaming` is false:**

- Existing `chat.postMessage` + `chat.update` behavior (unchanged).

#### ActiveStream Changes

Add optional `streamId` field for native streaming:

```typescript
export interface ActiveStream {
  // ... existing fields ...
  /** Slack streaming API stream_id (only set when nativeStreaming is true). */
  nativeStreamId?: string;
}
```

#### Fallback

If `chat.startStream` fails (e.g., bot lacks required scope), log a warning and fall back to the `chat.update` approach for the remainder of that stream. Do not disable `nativeStreaming` globally — the failure may be transient or channel-specific.

#### SlackDeliverOptions

Add `nativeStreaming: boolean` to `SlackDeliverOptions`. Thread it from `slack-adapter.ts` config.

### Telegram: `sendMessageDraft`

Telegram Bot API 9.5 (March 1, 2026) made `sendMessageDraft` available to all bots. This enables native ChatGPT-style streaming in DMs — the recipient sees text appearing character by character.

**Constraint:** `sendMessageDraft` only works in private chats (DMs). Groups still need the existing buffer-and-flush approach.

#### Config

Add a `streaming` config field to the Telegram adapter:

```typescript
// In telegram-adapter.ts config fields
{
  key: 'streaming',
  label: 'Streaming',
  description: 'Stream responses in real-time using Telegram\'s sendMessageDraft API (DMs only). Groups always use buffer-and-flush.',
  type: 'boolean',
  default: true,
}
```

#### Implementation

In `telegram/outbound.ts`, modify the `text_delta` handler:

**When `streaming` is true AND chat is a DM (chatId > 0):**

- Each `text_delta`: Call `bot.api.sendMessageDraft(chatId, accumulatedText)` (throttled to ~200ms intervals to stay within rate limits).
- `done`: Call `bot.api.sendMessage(chatId, finalText)` to finalize the draft into a permanent message.
- `error`: Call `bot.api.sendMessage(chatId, finalText + errorSuffix)`.

**When `streaming` is false OR chat is a group (chatId < 0):**

- Existing buffer-and-flush behavior (unchanged).

#### DM vs Group Detection

Telegram convention: positive `chatId` = private/DM, negative `chatId` = group/supergroup/channel. Use `chatId > 0` to detect DMs.

#### Throttling

`sendMessageDraft` should be throttled to ~200ms intervals (5 updates/sec) to balance smooth UX with rate limit safety. Use the same throttle pattern as Slack's `STREAM_UPDATE_INTERVAL_MS`, but with a shorter interval:

```typescript
const DRAFT_UPDATE_INTERVAL_MS = 200;
```

#### TelegramDeliverOptions

Add `streaming: boolean` to `TelegramDeliverOptions`. Thread it from `telegram-adapter.ts` config.

#### grammY Compatibility

Verify that the installed `grammy` version supports `bot.api.sendMessageDraft()`. If not available, the implementation should check at startup and log a warning, falling back to buffer-and-flush.

---

## Phase 3: Buffer Cleanup + Test Coverage

### Telegram Buffer TTL Reaping

The `responseBuffers` Map in `telegram/outbound.ts` has no cleanup mechanism. If an agent crashes without sending `done` or `error`, the buffer persists indefinitely.

**Fix:** Add TTL reaping matching the Slack adapter's pattern.

#### Implementation

1. Change `responseBuffers` from `Map<number, string>` to `Map<number, ResponseBuffer>`:

```typescript
interface ResponseBuffer {
  text: string;
  startedAt: number;
}
```

2. Add `BUFFER_TTL_MS = 5 * 60 * 1_000` constant (matches Slack's `STREAM_TTL_MS`).

3. At the top of `deliverMessage()`, reap stale buffers:

```typescript
for (const [key, buf] of responseBuffers) {
  if (startTime - buf.startedAt > BUFFER_TTL_MS) {
    responseBuffers.delete(key);
  }
}
```

4. Update all `responseBuffers.set()` calls to use the new shape:
   - `responseBuffers.set(chatId, { text: existing + textChunk, startedAt: existingBuf?.startedAt ?? Date.now() })`

5. Update all `responseBuffers.get()` reads to access `.text`.

### Test Coverage

#### Telegram `outbound.test.ts` — New delivery tests

The current file only tests typing indicators. Add comprehensive delivery tests:

```
describe('deliverMessage')
  describe('echo prevention')
  describe('guard conditions')
  describe('standard payload delivery')
  describe('streaming — text_delta buffering')
  describe('streaming — done flush')
  describe('streaming — error flush')
  describe('event whitelist — unknown events silently dropped')
  describe('buffer TTL reaping')
  describe('sendMessageDraft streaming') // Phase 2
```

#### Slack `outbound.test.ts` — Native streaming tests (Phase 2)

```
describe('native streaming — chat.startStream/appendStream/stopStream')
  it('starts stream on first text_delta')
  it('appends text on subsequent text_delta')
  it('stops stream on done')
  it('appends error and stops stream on error')
  it('falls back to chat.update when startStream fails')
```

---

## Acceptance Criteria

### Phase 1 (Critical)

- [ ] `SILENT_EVENT_TYPES` is deleted from `payload-utils.ts`
- [ ] Both adapters silently drop all unrecognized StreamEvent types
- [ ] No raw JSON appears in Slack or Telegram for any of the 29 current event types
- [ ] Unknown future event types (`some_future_event_xyz`) are silently dropped
- [ ] Standard (non-StreamEvent) payloads still deliver normally
- [ ] Existing text_delta/error/done behavior is unchanged
- [ ] All existing tests pass with updated assertions

### Phase 2 (Enhancement)

- [ ] Slack adapter uses `chat.startStream`/`appendStream`/`stopStream` when `nativeStreaming: true`
- [ ] Slack adapter falls back to `chat.update` when native streaming fails
- [ ] Telegram adapter uses `sendMessageDraft` for DMs when `streaming: true`
- [ ] Telegram adapter uses buffer-and-flush for groups regardless of config
- [ ] Both streaming modes are configurable and on by default
- [ ] Config fields appear in adapter setup UI

### Phase 3 (Defensive)

- [ ] Telegram `responseBuffers` entries are reaped after 5 minutes
- [ ] Telegram outbound has comprehensive delivery test coverage
- [ ] Slack outbound has native streaming test coverage

---

## Migration / Backward Compatibility

- Phase 1 is fully backward compatible — standard payload delivery is unchanged, only stream events are affected
- Phase 2 introduces new config fields with `default: true` — existing adapters get native streaming automatically
- If `chat.startStream` or `sendMessageDraft` are not available (older SDK versions), adapters fall back gracefully
- No API contract changes, no database migrations, no breaking config changes

---

## Files Modified

| File                                                              | Phase   | Change                                                                                       |
| ----------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `packages/relay/src/lib/payload-utils.ts`                         | 1       | Delete `SILENT_EVENT_TYPES` export                                                           |
| `packages/relay/src/adapters/slack/outbound.ts`                   | 1, 2    | Remove SILENT_EVENT_TYPES import, add whitelist return; add native streaming                 |
| `packages/relay/src/adapters/telegram/outbound.ts`                | 1, 2, 3 | Remove SILENT_EVENT_TYPES import, add whitelist return; add sendMessageDraft; add buffer TTL |
| `packages/relay/src/adapters/slack/slack-adapter.ts`              | 2       | Add `nativeStreaming` config field, thread to deliver options                                |
| `packages/relay/src/adapters/telegram/telegram-adapter.ts`        | 2       | Add `streaming` config field, thread to deliver options                                      |
| `packages/relay/src/adapters/slack/__tests__/outbound.test.ts`    | 1, 2    | Replace silent event tests with whitelist tests; add native streaming tests                  |
| `packages/relay/src/adapters/telegram/__tests__/outbound.test.ts` | 1, 2, 3 | Add comprehensive delivery tests, whitelist tests, buffer TTL tests                          |
| `packages/relay/src/lib/__tests__/payload-utils.test.ts`          | 1       | Remove SILENT_EVENT_TYPES tests (if present)                                                 |

---

## Risk Assessment

| Risk                                                 | Likelihood | Impact | Mitigation                                           |
| ---------------------------------------------------- | ---------- | ------ | ---------------------------------------------------- |
| `chat.startStream` requires unknown OAuth scope      | Medium     | Low    | Fallback to `chat.update` on failure                 |
| grammY doesn't support `sendMessageDraft` yet        | Low        | Low    | Check at startup, fall back to buffer-and-flush      |
| Removing `SILENT_EVENT_TYPES` breaks other consumers | Low        | Low    | Grep confirms only Slack/Telegram outbound import it |
| Native streaming changes message appearance in Slack | Low        | Medium | Controlled by `nativeStreaming` config toggle        |
