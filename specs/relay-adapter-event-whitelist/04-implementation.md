# Implementation Summary: Relay Adapter Event Whitelist Overhaul

**Created:** 2026-03-17
**Last Updated:** 2026-03-17
**Spec:** specs/relay-adapter-event-whitelist/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 5 / 5

## Tasks Completed

### Session 1 - 2026-03-17

- Task #1: [P1] Delete SILENT_EVENT_TYPES and add whitelist return in Slack outbound
- Task #2: [P1] Add whitelist return in Telegram outbound and delivery tests
- Task #3: [P2] Add Slack native streaming API support (chat.startStream/appendStream/stopStream)
- Task #4: [P2] Add Telegram sendMessageDraft streaming support
- Task #5: [P3] Add Telegram buffer TTL reaping for orphaned response buffers

## Files Modified/Created

**Source files:**

- `packages/relay/src/lib/payload-utils.ts` — Deleted `SILENT_EVENT_TYPES` export
- `packages/relay/src/adapters/slack/outbound.ts` — Whitelist return, native streaming (startStream/appendStream/stopStream), `nativeStreamId` on ActiveStream
- `packages/relay/src/adapters/slack/slack-adapter.ts` — Added `nativeStreaming` config field, threaded to deliver options
- `packages/relay/src/adapters/telegram/outbound.ts` — Whitelist return, sendMessageDraft streaming with throttling, ResponseBuffer type with TTL reaping
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` — Added `streaming` config field, updated responseBuffers type to `Map<number, ResponseBuffer>`
- `packages/shared/src/relay-adapter-schemas.ts` — Added `nativeStreaming` to Slack schema, `streaming` to Telegram schema

**Test files:**

- `packages/relay/src/lib/__tests__/payload-utils.test.ts` — Removed SILENT_EVENT_TYPES tests (48 tests)
- `packages/relay/src/adapters/slack/__tests__/outbound.test.ts` — Whitelist tests + 5 native streaming tests (42 tests)
- `packages/relay/src/adapters/telegram/__tests__/outbound.test.ts` — 30 delivery tests + 6 sendMessageDraft tests + 3 TTL reaping tests (47 tests)

## Known Issues

_(None)_

## Implementation Notes

### Session 1

- Batch 1 (Phase 1 whitelist fix) — 2 tasks in parallel, 123 tests passing
- Batch 2 (Phase 2 native streaming) — 2 tasks in parallel, 134 tests passing
- Batch 3 (Phase 3 buffer TTL) — 1 task, 137 tests passing
- Slack agent needed manual fix: stopStream in handleDone/handleError + native streaming tests were missing
- Total: 137 relay tests across 3 test files, all passing
