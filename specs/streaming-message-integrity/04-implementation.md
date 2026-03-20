# Implementation Summary: Streaming Message Integrity

**Created:** 2026-03-19
**Last Updated:** 2026-03-19
**Spec:** specs/streaming-message-integrity/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 10 / 10

## Tasks Completed

### Session 1 - 2026-03-19

- Task #1: [P1] Add \_streaming flag to ChatMessage and tag streaming messages
- Task #2: [P1] Remove post-stream history reset and invalidation
- Task #3: [P1] Implement smart tagged-dedup in seed effect Branch 2
- Task #4: [P1] Remove setMessages([]) from session remap in done handler
- Task #5: [P2] Extend transcript parser to extract error, subagent, and hook blocks
- Task #6: [P3] Add getLastMessageIds to AgentRuntime interface and FakeAgentRuntime
- Task #7: [P3] Implement getLastMessageIds in ClaudeCodeRuntime
- Task #8: [P3] Include messageIds in done SSE event and accept clientMessageId
- Task #9: [P3] Handle server-echo messageIds in client done handler for ID remap
- Task #10: [P4] Update contributing docs to reflect removed post-stream invalidation

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/features/chat/model/chat-types.ts` — Added `_streaming?: boolean` to ChatMessage
- `apps/client/src/layers/features/chat/model/stream-event-helpers.ts` — Tagged assistant messages with `_streaming: true`
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Tagged user message, removed post-stream reset, implemented tagged-dedup Branch 2, passes clientMessageId
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — Removed setMessages([]) from remap, added messageIds Phase 3 ID remap in done handler
- `apps/client/src/layers/shared/lib/transport/http-transport.ts` — Added options parameter with clientMessageId in POST body
- `apps/client/src/layers/shared/lib/direct-transport.ts` — Accept new sendMessage signature
- `packages/shared/src/transport.ts` — Extended sendMessage with optional options parameter
- `packages/shared/src/schemas.ts` — Added clientMessageId to SendMessageRequestSchema
- `packages/shared/src/agent-runtime.ts` — Added getLastMessageIds to AgentRuntime interface
- `packages/test-utils/src/fake-agent-runtime.ts` — Added getLastMessageIds stub
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — Implemented getLastMessageIds
- `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts` — Added getLastMessageIds stub
- `apps/server/src/services/runtimes/claude-code/transcript-parser.ts` — Added error/subagent block extraction
- `apps/server/src/routes/sessions.ts` — Done event includes messageIds

**Test files:**

- `apps/client/src/layers/features/chat/model/__tests__/tagged-dedup.test.ts` — 7 tests for tagged-dedup logic
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-remap.test.ts` — Updated + 5 new tests for messageIds remap
- `apps/client/src/layers/features/chat/__tests__/use-chat-session.test.tsx` — Updated sendMessage assertion
- `apps/server/src/services/__tests__/transcript-parser.test.ts` — 6 new tests for error/subagent extraction
- `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime-getlastmessageids.test.ts` — 9 tests for getLastMessageIds

## Known Issues

- **Hook blocks not extracted as top-level MessageParts**: `HookPartSchema` has no `type` discriminator and is not in the `MessagePartSchema` union. Hooks exist only inside `ToolCallPart.hooks`. The tagged-dedup filter correctly uses `subagent` only (not `hook`) for client-only part carry-over. To support standalone hook parts in the future, the schema would need a `type: z.literal('hook')` field.

## Implementation Notes

### Session 1

All three phases implemented in a single session. The react-tanstack-expert agent implemented all client and server changes with full test coverage. Key deviations from the spec:

1. **ErrorPart schema**: The spec referenced an `errorType` field that doesn't exist in `ErrorPartSchema`. The actual `category` field (using `ErrorCategory` enum) serves this purpose.
2. **SubagentPart status values**: Spec used `'started' | 'streaming' | 'completed' | 'error'` but actual `SubagentStatusSchema` defines `'running' | 'complete' | 'error'`. Implementation uses the correct schema values.
3. **Hook extraction deferred**: Hook blocks are nested inside ToolCallPart, not standalone MessageParts. Extraction as top-level parts requires a schema change (adding `type` discriminator to HookPartSchema).
4. **Docs unchanged**: Neither `contributing/data-fetching.md` nor `contributing/architecture.md` document the seed effect internals, so no updates were needed.
