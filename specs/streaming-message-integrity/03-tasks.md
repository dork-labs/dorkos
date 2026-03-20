# Task Breakdown: Streaming Message Integrity

Generated: 2026-03-19
Source: specs/streaming-message-integrity/02-specification.md
Last Decompose: 2026-03-19

## Overview

Fix two bugs in the DorkOS chat UI (message flash on stream completion, disappearing error messages) caused by the post-stream history replace in `use-chat-session.ts`. Extend the transcript parser to extract error/subagent/hook parts from JSONL. Implement server-echo ID to eliminate content/position-based message matching.

**Phase 1** (client-only) fixes both bugs immediately by skipping the post-stream replace and using tagged-message dedup. **Phase 2** (server-side) fixes data loss when loading past sessions from disk. **Phase 3** (client + server) replaces content/position matching with exact ID-based dedup via the `done` SSE event. **Phase 4** updates documentation.

---

## Phase 1: Foundation — Tagged-Dedup Client Fix

### Task 1.1: Add \_streaming flag to ChatMessage and tag streaming messages

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.1

Add `_streaming?: boolean` to `ChatMessage` interface in `chat-types.ts`. Tag optimistic user message in `use-chat-session.ts` and assistant message in `stream-event-helpers.ts` with `_streaming: true`.

**Files changed:**

- `apps/client/src/layers/features/chat/model/chat-types.ts` — add field
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — tag user message
- `apps/client/src/layers/features/chat/model/stream-event-helpers.ts` — tag assistant message

**Acceptance Criteria:**

- [ ] `ChatMessage` interface has `_streaming?: boolean` with `@internal` TSDoc
- [ ] Optimistic user message tagged with `_streaming: true`
- [ ] Assistant message in `ensureAssistantMessage` tagged with `_streaming: true`
- [ ] TypeScript compiles, existing tests pass

---

### Task 1.2: Remove post-stream history reset and invalidation

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

Remove `historySeededRef.current = false` and `queryClient.invalidateQueries({ queryKey: ['messages'] })` from `executeSubmission` in `use-chat-session.ts`. Keep `pendingUserIdRef.current = null` and `setStatus('idle')`.

**Files changed:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — remove 3 lines

**Acceptance Criteria:**

- [ ] Post-stream reset removed
- [ ] Messages no longer flash on stream completion
- [ ] Existing polling interval handles eventual consistency

---

### Task 1.3: Implement smart tagged-dedup in seed effect Branch 2

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

Rewrite the seed effect's Branch 2 (incremental append) to match tagged messages by content (user) or position (assistant), carry over client-only parts (error, subagent, hook), and clear `_streaming` flag on match.

**Files changed:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — rewrite Branch 2

**New test file:**

- `apps/client/src/layers/features/chat/model/__tests__/tagged-dedup.test.ts`

**Acceptance Criteria:**

- [ ] Tagged user messages matched by exact content, replaced with server version
- [ ] Tagged assistant messages matched by position after matched user
- [ ] Client-only parts carried over to merged message
- [ ] `_streaming` flag cleared on match
- [ ] Unmatched messages appended normally
- [ ] 6 unit tests written and passing

---

### Task 1.4: Remove setMessages([]) from session remap in done handler

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 1.2, Task 1.3

Remove `setMessages([])` from the done event handler's remap branch in `stream-event-handler.ts`. Update `doneData` type to include optional `messageIds` (prep for Phase 3). Update existing remap test to assert messages are preserved.

**Files changed:**

- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — remove setMessages([])
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-remap.test.ts` — update assertion

**Acceptance Criteria:**

- [ ] `setMessages([])` removed from remap branch
- [ ] Refs still reset, callback still fires
- [ ] Existing test updated to verify messages NOT cleared
- [ ] First message in new session no longer causes blank flash

---

## Phase 2: Transcript Parser Fix (Server-Side)

### Task 2.1: Extend transcript parser to extract error, subagent, and hook blocks

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.3, 1.4

Add handlers for `error`, `subagent`, and `hook` content blocks in `parseTranscript`. Map snake_case JSONL fields to camelCase `MessagePart` types. Use defensive access with fallback defaults.

**Files changed:**

- `apps/server/src/services/runtimes/claude-code/transcript-parser.ts` — add 3 block handlers
- `apps/server/src/services/__tests__/transcript-parser.test.ts` — add 5 test cases

**Acceptance Criteria:**

- [ ] Error blocks extracted as `ErrorPart`
- [ ] Subagent blocks extracted as `SubagentPart`
- [ ] Hook blocks extracted as `HookPart`
- [ ] Missing fields fall back to safe defaults
- [ ] Existing extraction not broken (regression test)
- [ ] 5 tests written and passing

---

## Phase 3: Server-Echo ID (Client + Server)

### Task 3.1: Add getLastMessageIds to AgentRuntime interface and FakeAgentRuntime

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.3, 1.4, 2.1

Add `getLastMessageIds(sessionId: string): Promise<{ user: string; assistant: string } | null>` to the `AgentRuntime` interface and implement as `vi.fn()` stub in `FakeAgentRuntime`.

**Files changed:**

- `packages/shared/src/agent-runtime.ts` — add method to interface
- `packages/test-utils` — add stub to FakeAgentRuntime

**Acceptance Criteria:**

- [ ] Method added to interface with TSDoc
- [ ] FakeAgentRuntime implements method
- [ ] TypeScript compiles across all packages

---

### Task 3.2: Implement getLastMessageIds in ClaudeCodeRuntime

**Size**: Small
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: None

Implement `getLastMessageIds` in `ClaudeCodeRuntime` using `TranscriptReader.getMessages` to walk backward and find last user/assistant IDs.

**Files changed:**

- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — add implementation

**Acceptance Criteria:**

- [ ] Returns `{ user, assistant }` for valid transcripts
- [ ] Returns `null` for empty transcripts or errors
- [ ] Errors caught and logged, not thrown
- [ ] 4 tests written and passing

---

### Task 3.3: Include messageIds in done SSE event and accept clientMessageId

**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.2
**Can run parallel with**: None

Modify sessions route to call `getLastMessageIds` after streaming and include result in done event. Add `clientMessageId` to `SendMessageRequestSchema`.

**Files changed:**

- `packages/shared/src/schemas.ts` — add `clientMessageId` to schema
- `apps/server/src/routes/sessions.ts` — modify done event handling

**Acceptance Criteria:**

- [ ] Done event includes `messageIds` when available
- [ ] Done event still includes `sessionId` on remap
- [ ] No extra done event when neither applies
- [ ] 3 tests written and passing

---

### Task 3.4: Handle server-echo messageIds in client done handler for ID remap

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, 1.4, 3.3
**Can run parallel with**: None

Update `Transport.sendMessage` signature with options parameter. Update `HttpTransport` and `DirectTransport`. Pass `clientMessageId` in `executeSubmission`. Handle `messageIds` in done event to remap client IDs to server IDs.

**Files changed:**

- `packages/shared/src/transport.ts` — extend sendMessage signature
- HttpTransport implementation — include clientMessageId in POST body
- DirectTransport implementation — accept options parameter
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — pass clientMessageId
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — handle messageIds

**Acceptance Criteria:**

- [ ] Transport interface extended with options parameter
- [ ] Both transport implementations updated
- [ ] Client sends clientMessageId on streaming request
- [ ] Done handler remaps IDs when messageIds present
- [ ] Falls back to tagged-dedup when messageIds absent
- [ ] 3 tests written and passing

---

## Phase 4: Documentation & Cleanup

### Task 4.1: Update contributing docs to reflect removed post-stream invalidation pattern

**Size**: Small
**Priority**: Low
**Dependencies**: Task 1.2, 1.3, 3.4
**Can run parallel with**: None

Update `contributing/data-fetching.md` and `contributing/architecture.md` if they reference the post-stream invalidation pattern. Remove stale inline comments.

**Files to check:**

- `contributing/data-fetching.md`
- `contributing/architecture.md`
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — stale comments

**Acceptance Criteria:**

- [ ] Documentation accurately describes tagged-dedup behavior
- [ ] No stale comments referencing removed reset pattern
