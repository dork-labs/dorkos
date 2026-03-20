# Relay Adapter Event Whitelist — Task Breakdown

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-03-17

---

## Phase 1: Whitelist Fix (Critical)

### Task 1.1 — Delete SILENT_EVENT_TYPES and add whitelist return in Slack outbound

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Remove the `SILENT_EVENT_TYPES` blacklist from `payload-utils.ts` and update Slack outbound delivery to use a whitelist model. After handling `text_delta`, `error`, and `done`, all other StreamEvent types return `{ success: true }` immediately, preventing fallthrough to `extractPayloadContent()` which would `JSON.stringify` unknown events.

**Files modified:**

- `packages/relay/src/lib/payload-utils.ts` — Delete `SILENT_EVENT_TYPES` export
- `packages/relay/src/adapters/slack/outbound.ts` — Remove import, add unconditional return before closing `}`
- `packages/relay/src/lib/__tests__/payload-utils.test.ts` — Remove `SILENT_EVENT_TYPES` test block
- `packages/relay/src/adapters/slack/__tests__/outbound.test.ts` — Replace `describe('silent event types')` with whitelist test covering 21 event types including fictional `some_future_event_xyz`

---

### Task 1.2 — Add whitelist return in Telegram outbound and delivery tests

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Same whitelist pattern for Telegram outbound. Additionally adds comprehensive delivery tests that currently don't exist — the test file only covers typing indicators today.

**Files modified:**

- `packages/relay/src/adapters/telegram/outbound.ts` — Remove `SILENT_EVENT_TYPES` import, add unconditional return
- `packages/relay/src/adapters/telegram/__tests__/outbound.test.ts` — Add `deliverMessage` tests: echo prevention, guard conditions, standard payload, text_delta buffering, done flush, error flush, whitelist (21 event types)

---

## Phase 2: Native Streaming APIs (Enhancement)

### Task 2.1 — Add Slack native streaming API support

**Size:** Large | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 2.2

Implement Slack's `chat.startStream`/`appendStream`/`stopStream` as an alternative to `chat.update` edit-in-place. Controlled by a new `nativeStreaming` config field (default: `true`). Falls back to `chat.update` if `startStream` fails.

**Files modified:**

- `packages/shared/src/relay-adapter-schemas.ts` — Add `nativeStreaming` to `SlackAdapterConfigSchema`
- `packages/relay/src/adapters/slack/slack-adapter.ts` — Add `nativeStreaming` config field to manifest, thread to deliver options
- `packages/relay/src/adapters/slack/outbound.ts` — Add `nativeStreaming` to options/interfaces, implement native streaming in handlers
- `packages/relay/src/adapters/slack/__tests__/outbound.test.ts` — Add 5 native streaming test cases

**Behavior matrix:**

| `streaming` | `nativeStreaming` | Behavior                             |
| ----------- | ----------------- | ------------------------------------ |
| `true`      | `true`            | Slack native streaming API           |
| `true`      | `false`           | `chat.update` edit-in-place (legacy) |
| `false`     | any               | Buffer-and-flush on done             |

---

### Task 2.2 — Add Telegram sendMessageDraft streaming support

**Size:** Large | **Priority:** Medium | **Dependencies:** 1.2 | **Parallel with:** 2.1

Implement Telegram's `sendMessageDraft` for ChatGPT-style streaming in DMs. Groups (negative chatId) always use buffer-and-flush. Throttled to ~200ms intervals.

**Files modified:**

- `packages/shared/src/relay-adapter-schemas.ts` — Add `streaming` to `TelegramAdapterConfigSchema`
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` — Add `streaming` config field to manifest, thread to deliver options
- `packages/relay/src/adapters/telegram/outbound.ts` — Add `streaming` to options, implement `sendMessageDraft` with throttling
- `packages/relay/src/adapters/telegram/__tests__/outbound.test.ts` — Add 6 streaming test cases

---

## Phase 3: Buffer Cleanup + Defensive

### Task 3.1 — Add Telegram buffer TTL reaping

**Size:** Medium | **Priority:** Low | **Dependencies:** 1.2 | **Parallel with:** None

Add TTL reaping to `responseBuffers` to prevent memory leaks from orphaned buffers (agent crashes without sending `done`/`error`). Changes buffer type from `Map<number, string>` to `Map<number, ResponseBuffer>` with `text` and `startedAt` fields. Reaping matches Slack's 5-minute TTL pattern.

**Files modified:**

- `packages/relay/src/adapters/telegram/outbound.ts` — Add `ResponseBuffer` interface, `BUFFER_TTL_MS`, reaping loop, update all buffer operations
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` — Update `responseBuffers` field type
- `packages/relay/src/adapters/telegram/__tests__/outbound.test.ts` — Update buffer shape in tests, add 3 TTL reaping tests

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 ──┐
  1.2 ──┤
        │
Phase 2 (parallel, after Phase 1):
  2.1 ──┤ (depends on 1.1)
  2.2 ──┤ (depends on 1.2)
        │
Phase 3:
  3.1 ──  (depends on 1.2)
```

## Summary

| Phase                | Tasks | Parallelizable |
| -------------------- | ----- | -------------- |
| 1 — Whitelist Fix    | 2     | 1.1 ∥ 1.2      |
| 2 — Native Streaming | 2     | 2.1 ∥ 2.2      |
| 3 — Buffer Cleanup   | 1     | —              |
| **Total**            | **5** |                |
