---
slug: fix-chatsdk-thread-id-subject-validation
number: 164
created: 2026-03-22
status: specified
---

# Fix Chat SDK Thread ID Subject Validation

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-03-22
**Ideation:** `specs/fix-chatsdk-thread-id-subject-validation/01-ideation.md`
**Research:** `research/20260322_fix_chatsdk_thread_id_subject_validation.md`

---

## Overview

Chat SDK adapters encode thread IDs as `{platform}:{chatId}` (e.g. `telegram:817732118`). The Chat SDK Telegram adapter's inbound handler passes this raw thread ID to `ThreadIdCodec.encode()`, which embeds it as a relay subject token. The colon fails `VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/`, causing all inbound messages from Chat SDK adapters to be silently rejected.

The fix is adapter-level normalization: extract the numeric chat ID from the Chat SDK thread ID before encoding it into the subject. This is a one-function, one-call-site change with zero blast radius.

## Background / Problem Statement

When a Telegram user sends a message to a bot connected via the Chat SDK Telegram adapter:

1. Chat SDK fires `onDirectMessage(thread, message)` where `thread.id = "telegram:817732118"`
2. `handleInboundMessage()` in `inbound.ts` passes `thread.id` directly to `codec.encode(thread.id, channelType)` (line 72)
3. The codec produces a subject containing the raw thread ID as a token: `relay.human.telegram-chatsdk.telegram:817732118`
4. `relay.publish()` validates the subject via `validateSubject()`, which rejects `telegram:817732118` because colons are not in `VALID_TOKEN_RE`
5. Error: `Invalid subject: Token "telegram:817732118" contains invalid characters (allowed: a-z, A-Z, 0-9, -, _)`

This breaks **all** inbound message routing for Chat SDK-based adapters. The native Telegram adapter (which uses grammy directly) does not have this issue because it passes bare numeric chat IDs.

**Root cause:** The Chat SDK adapter's inbound handler is missing the translation step from Chat SDK's internal thread ID format to a relay-compatible platform ID.

## Goals

- Fix inbound message routing for the Chat SDK Telegram adapter
- Ensure the fix handles all Chat SDK thread ID formats (DM, group, forum topics)
- Maintain backward compatibility with existing subjects and outbound delivery
- Preserve the original Chat SDK thread ID in `platformData.threadId` for downstream consumers

## Non-Goals

- Per-forum-thread routing (forum topics map to the same subject as the parent chat)
- Changes to `VALID_TOKEN_RE` or the subject validation contract
- Changes to the `ThreadIdCodec` interface or implementations
- Changes to the outbound delivery path (`outbound.ts`)
- Shared utility extraction for future Chat SDK adapters (YAGNI — only Telegram exists)
- Changes to the native Telegram adapter

## Technical Dependencies

- `packages/relay/src/adapters/telegram-chatsdk/inbound.ts` — bug location
- `packages/relay/src/lib/thread-id.ts` — `ChatSdkTelegramThreadIdCodec` (read-only, no changes)
- `packages/relay/src/subject-matcher.ts` — `VALID_TOKEN_RE` (read-only, no changes)
- `chat` npm package — `Thread.id` format: `{platform}:{chatId}` or `{platform}:{chatId}:{messageThreadId}`

## Detailed Design

### The Fix

Add an `extractChatIdFromThreadId` helper function to `inbound.ts` and call it before `codec.encode()`.

#### `extractChatIdFromThreadId` implementation

```typescript
/**
 * Extract the numeric chat ID from a Chat SDK thread ID.
 *
 * Chat SDK encodes thread IDs as `{platform}:{chatId}` (simple chats) or
 * `{platform}:{chatId}:{messageThreadId}` (forum topics). For Relay subject
 * encoding we only need the chatId segment — the platform prefix is already
 * captured in the adapter's subject namespace (telegram-chatsdk), and
 * messageThreadId is not used for routing.
 *
 * Falls back to the raw thread.id if no colon is found, preserving existing
 * behavior for unknown formats.
 *
 * @param threadId - The Chat SDK thread ID (e.g. "telegram:817732118")
 * @returns The numeric chat ID as a string (e.g. "817732118")
 */
function extractChatIdFromThreadId(threadId: string): string {
  const colonIdx = threadId.indexOf(':');
  if (colonIdx === -1) return threadId;
  const afterPlatform = threadId.slice(colonIdx + 1);
  // For forum topics: "telegram:817732118:42" → strip messageThreadId
  const secondColon = afterPlatform.indexOf(':');
  return secondColon === -1 ? afterPlatform : afterPlatform.slice(0, secondColon);
}
```

#### Call site change in `handleInboundMessage`

```typescript
// Before (line 72):
const subject = resolvedCodec.encode(thread.id, channelType);

// After:
const chatId = extractChatIdFromThreadId(thread.id);
const subject = resolvedCodec.encode(chatId, channelType);
```

#### What stays the same

- **Line 74** (`const channelName = thread.isDM ? undefined : thread.id`) — `channelName` uses the raw thread ID, which is fine for display purposes
- **Line 89** (`threadId: thread.id`) — `platformData.threadId` preserves the original Chat SDK thread ID for downstream consumers
- **Outbound path** — `deliverMessage()` and `deliverStream()` in `outbound.ts` receive the bare numeric chat ID from `codec.decode()` and pass it to `telegramAdapter.postMessage()`, which accepts bare numeric chat IDs

### Architecture

```
Inbound data flow (FIXED):
  Chat SDK onDirectMessage(thread, message)
    → thread.id = "telegram:817732118"
    → extractChatIdFromThreadId("telegram:817732118") → "817732118"
    → codec.encode("817732118", "dm")
    → subject = "relay.human.telegram-chatsdk.test-chatsdk.817732118"
    → relay.publish(subject, payload) ← Now passes validation ✓

Outbound data flow (UNCHANGED):
  relay subscription fires with subject "relay.human.telegram-chatsdk.test-chatsdk.817732118"
    → codec.decode(subject) → { platformId: "817732118", channelType: "dm" }
    → telegramAdapter.postMessage("817732118", { raw: chunk })
    → Chat SDK accepts bare numeric chatId ✓
```

### Thread ID Format Reference

| Chat SDK Format                     | `extractChatIdFromThreadId` Output | Use Case              |
| ----------------------------------- | ---------------------------------- | --------------------- |
| `telegram:817732118`                | `817732118`                        | DM                    |
| `telegram:-100123456789`            | `-100123456789`                    | Group chat            |
| `telegram:817732118:42`             | `817732118`                        | Forum topic           |
| `817732118` (no prefix)             | `817732118`                        | Fallback/pass-through |
| `slack:C01234567` (future)          | `C01234567`                        | Slack DM              |
| `discord:1234567890123456` (future) | `1234567890123456`                 | Discord               |

### Why Not Other Approaches

1. **Expand `VALID_TOKEN_RE` to allow colons** — Rejected. Subjects are used as filesystem directory names (Windows forbids colons, macOS HFS+ discourages them). Also violates NATS spec that DorkOS subjects model.

2. **Codec-level sanitization** — Rejected. Wrong layer — the codec's contract is "encode a subject-safe platformId." The adapter should present subject-safe IDs.

3. **URL-encode the platformId** — Rejected. `%` is also not in `VALID_TOKEN_RE`, so this fails the same validation.

## User Experience

No user-facing changes. Messages from Telegram will be routed correctly to bound agents. Previously, all inbound messages from Chat SDK adapters were silently dropped with an error in server logs.

## Testing Strategy

### Unit Tests

Add test cases to `packages/relay/src/adapters/telegram-chatsdk/__tests__/adapter.test.ts` (the existing test file for this adapter):

```typescript
// New test cases for inbound thread ID normalization

it('normalizes Chat SDK thread ID format for DM messages', async () => {
  await adapter.start(relay);
  const thread = buildMockThread({ id: 'telegram:817732118', isDM: true });
  const message = buildMockMessage({ text: 'Hello' });

  await messageHandlers['directMessage']!(thread, message);

  expect(relay.publish).toHaveBeenCalledWith(
    'relay.human.telegram-chatsdk.test-chatsdk.817732118',
    expect.objectContaining({ content: 'Hello' }),
    expect.anything()
  );
});

it('normalizes Chat SDK thread ID format for group messages', async () => {
  await adapter.start(relay);
  const thread = buildMockThread({ id: 'telegram:-100123456789', isDM: false });
  const message = buildMockMessage({ text: 'Group msg' });

  await messageHandlers['newMention']!(thread, message);

  expect(relay.publish).toHaveBeenCalledWith(
    'relay.human.telegram-chatsdk.test-chatsdk.group.-100123456789',
    expect.objectContaining({ channelType: 'group' }),
    expect.anything()
  );
});

it('strips forum thread ID suffix from Chat SDK thread ID', async () => {
  await adapter.start(relay);
  const thread = buildMockThread({ id: 'telegram:817732118:42', isDM: true });
  const message = buildMockMessage({ text: 'Forum msg' });

  await messageHandlers['directMessage']!(thread, message);

  expect(relay.publish).toHaveBeenCalledWith(
    'relay.human.telegram-chatsdk.test-chatsdk.817732118',
    expect.objectContaining({ content: 'Forum msg' }),
    expect.anything()
  );
});

it('passes through thread IDs that have no colon prefix', async () => {
  await adapter.start(relay);
  const thread = buildMockThread({ id: '99999', isDM: true });
  const message = buildMockMessage({ text: 'Raw ID' });

  await messageHandlers['directMessage']!(thread, message);

  expect(relay.publish).toHaveBeenCalledWith(
    'relay.human.telegram-chatsdk.test-chatsdk.99999',
    expect.objectContaining({ content: 'Raw ID' }),
    expect.anything()
  );
});

it('preserves original Chat SDK thread ID in platformData.threadId', async () => {
  await adapter.start(relay);
  const thread = buildMockThread({ id: 'telegram:817732118', isDM: true });
  const message = buildMockMessage({ text: 'Check platformData' });

  await messageHandlers['directMessage']!(thread, message);

  expect(relay.publish).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      platformData: expect.objectContaining({ threadId: 'telegram:817732118' }),
    }),
    expect.anything()
  );
});
```

### Unit Tests for `extractChatIdFromThreadId`

Add focused unit tests for the helper function itself. Since the function is module-private, test it indirectly through `handleInboundMessage` (already covered above). If the function is exported for testing, add direct tests:

```typescript
describe('extractChatIdFromThreadId', () => {
  it('extracts chatId from telegram:chatId format', () => {
    expect(extractChatIdFromThreadId('telegram:817732118')).toBe('817732118');
  });

  it('extracts chatId from negative group ID', () => {
    expect(extractChatIdFromThreadId('telegram:-100123456789')).toBe('-100123456789');
  });

  it('strips messageThreadId from forum topic format', () => {
    expect(extractChatIdFromThreadId('telegram:817732118:42')).toBe('817732118');
  });

  it('passes through IDs without colons', () => {
    expect(extractChatIdFromThreadId('817732118')).toBe('817732118');
  });

  it('handles empty string', () => {
    expect(extractChatIdFromThreadId('')).toBe('');
  });

  it('handles slack format for future adapters', () => {
    expect(extractChatIdFromThreadId('slack:C01234567')).toBe('C01234567');
  });
});
```

### Existing Tests

The existing test `publishes to relay when a direct message handler fires` uses `buildMockThread({ id: '99999' })` — a bare numeric ID with no colon. This test continues to pass (fallback path). The new tests above cover the Chat SDK format specifically.

### Integration Testing

Manual verification on dev:

1. Start dev server with Chat SDK Telegram adapter bound to an agent
2. Send "hello" from Telegram
3. Verify no `Invalid subject` error in server logs
4. Verify the agent receives the message and responds
5. Verify the response is delivered back to Telegram

## Performance Considerations

Zero overhead. `extractChatIdFromThreadId` performs two `indexOf(':')` calls on a string of ~20 characters. O(n) where n < 50.

## Security Considerations

- **No injection risk.** `extractChatIdFromThreadId` produces a substring of the original string using `indexOf` and `slice`. No regex, no eval, no external format parsing.
- **Subject validation preserved.** The extracted chatId still passes through `codec.encode()` → `relay.publish()` → `validateSubject()`. Any unexpected characters would be caught at publication time.
- **No new attack surface.** The function reduces the character set of the input (removes colons), it does not expand it.

## Documentation

No documentation changes needed. This is an internal bug fix with no API surface changes.

## Implementation Phases

### Phase 1: Fix (single phase — this is a bug fix)

1. Add `extractChatIdFromThreadId` helper to `packages/relay/src/adapters/telegram-chatsdk/inbound.ts`
2. Update line 72 to call `extractChatIdFromThreadId(thread.id)` before `codec.encode()`
3. Export the helper with `@internal` tag for direct unit testing
4. Add 5 integration-style test cases to `adapter.test.ts` covering Chat SDK thread ID formats
5. Add 6 focused unit tests for `extractChatIdFromThreadId`
6. Verify existing tests still pass
7. Run typecheck + lint

## Open Questions

None. All decisions resolved during ideation (see Section 6 of `01-ideation.md`).

## Related ADRs

- ADR-0179: Centralized AdapterStreamManager (from `chat-sdk-relay-adapter-refactor` spec)
- ADR-0178: PlatformClient Interface for Relay Adapters (from `chat-sdk-relay-adapter-refactor` spec)

## References

- `specs/fix-chatsdk-thread-id-subject-validation/01-ideation.md` — Ideation document
- `research/20260322_fix_chatsdk_thread_id_subject_validation.md` — Full research report with 4 approaches evaluated
- `research/20260322_chat_sdk_telegram_relay_integration.md` — Chat SDK integration patterns
- `research/20260321_relay_subject_folder_names.md` — Subject-as-filesystem-path constraints
- `specs/chat-sdk-relay-adapter-refactor/02-specification.md` — Spec that created the Chat SDK adapter
- `specs/adapter-binding-improvements/02-specification.md` — Instance-aware subjects and `parseSubject()`
- [NATS Subject-Based Messaging](https://docs.nats.io/nats-concepts/subjects) — Character constraints DorkOS follows
- [Enterprise Integration Patterns: Messaging Bridge](https://www.enterpriseintegrationpatterns.com/patterns/messaging/MessagingBridge.html) — Bridges normalize IDs at boundaries
