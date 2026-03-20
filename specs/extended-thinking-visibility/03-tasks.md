# Task Breakdown: Extended Thinking Visibility

Generated: 2026-03-16
Source: specs/extended-thinking-visibility/02-specification.md
Last Decompose: 2026-03-16

## Overview

Surface Claude's extended thinking blocks in the DorkOS chat UI. The SDK emits thinking content blocks that are currently silently dropped. This feature maps thinking blocks through the full pipeline: server mapper -> SSE transport -> client stream handler -> ThinkingBlock component. Thinking content also persists across page reloads via JSONL transcript parsing.

## Phase 1: Foundation

### Task 1.1: Add ThinkingPartSchema and thinking_delta to shared schemas

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Technical Requirements**:

- Add `thinking_delta` to `StreamEventTypeSchema` enum
- Create `ThinkingDeltaSchema` with `{ text: z.string() }` shape
- Create `ThinkingPartSchema` with `{ type: 'thinking', text, isStreaming?, elapsedMs? }`
- Add `ThinkingPartSchema` to `MessagePartSchema` discriminated union
- Add `ThinkingDeltaSchema` to `StreamEventSchema.data` union
- Ensure types are re-exported from `@dorkos/shared/types`

**Implementation Steps**:

1. Add `'thinking_delta'` to the `StreamEventTypeSchema` enum before `'text_delta'`
2. Add `ThinkingDeltaSchema` after `TextDeltaSchema`
3. Add `ThinkingPartSchema` after `SubagentPartSchema`
4. Add `ThinkingPartSchema` to the `MessagePartSchema` discriminated union
5. Add `ThinkingDeltaSchema` to `StreamEventSchema` data union
6. Verify type re-exports

**Acceptance Criteria**:

- [ ] `StreamEventTypeSchema` includes `'thinking_delta'`
- [ ] `ThinkingDeltaSchema` exists with correct shape
- [ ] `ThinkingPartSchema` exists with correct shape
- [ ] `MessagePartSchema` includes `ThinkingPartSchema`
- [ ] Types exported from `@dorkos/shared/types`
- [ ] `pnpm typecheck` passes
- [ ] Existing tests still pass

---

### Task 1.2: Add thinking tracking fields to ToolState in agent-types.ts

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:

- Add `inThinking: boolean` and `thinkingStartMs: number` to `ToolState` interface
- Update `createToolState()` factory with getter/setter closures for new fields
- Initialize `inThinking = false` and `thinkingStartMs = 0`

**Implementation Steps**:

1. Add fields to `ToolState` interface
2. Add closure variables and getter/setter pairs to `createToolState()`

**Acceptance Criteria**:

- [ ] `ToolState` interface includes new fields
- [ ] `createToolState()` initializes both fields
- [ ] Fields are readable and writable
- [ ] `pnpm typecheck` passes
- [ ] Existing tests still compile and pass

---

## Phase 2: Server Pipeline

### Task 2.1: Add thinking block handling to sdk-event-mapper.ts

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

**Technical Requirements**:

- Handle `content_block_start(thinking)` -> set `toolState.inThinking = true`, no event emitted
- Handle `content_block_delta(thinking_delta)` -> yield `{ type: 'thinking_delta', data: { text } }` when `inThinking`
- Handle `content_block_stop` during thinking -> reset `inThinking`, no event emitted
- SDK uses `delta.thinking` (not `delta.text`) for thinking content

**Implementation Steps**:

1. Add thinking check in `content_block_start` before `tool_use` check
2. Add `thinking_delta` branch in `content_block_delta` before `text_delta` check
3. Add `inThinking` check in `content_block_stop` before `inTool` check

**Acceptance Criteria**:

- [ ] Thinking start sets flag, emits nothing
- [ ] Thinking delta yields event when flag is set
- [ ] Thinking delta ignored when flag is not set
- [ ] Thinking stop resets flag, emits nothing
- [ ] No regressions in existing handling
- [ ] Tests written and passing

---

### Task 2.2: Add thinking block parsing to transcript-parser.ts

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- Add `thinking?: string` field to `ContentBlock` interface
- Add thinking branch to assistant content block loop BEFORE text check
- SDK JSONL uses `thinking` field (not `text`) for thinking content
- Thinking parts have `isStreaming: false` (history is always collapsed)

**Implementation Steps**:

1. Add `thinking` field to `ContentBlock` interface
2. Add thinking branch in content block loop
3. Handle edge cases: empty thinking, missing field

**Acceptance Criteria**:

- [ ] Thinking content blocks produce `ThinkingPart` entries
- [ ] Parts have `isStreaming: false`
- [ ] Thinking parts appear before text parts
- [ ] Empty/missing thinking handled gracefully
- [ ] No regression for non-thinking messages
- [ ] Tests written and passing

---

## Phase 3: Client Stream Handler

### Task 3.1: Add thinking_delta handling to stream-event-handler.ts

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- Add `thinkingStartRef` to `StreamEventDeps` interface
- Add `thinking_delta` case to switch statement
- Modify `text_delta` case to finalize in-progress thinking parts (set `isStreaming: false`, compute `elapsedMs`)
- Reset `thinkingStartRef` in `done` handler
- Update calling site to provide `thinkingStartRef`

**Implementation Steps**:

1. Add `thinkingStartRef` to interface and destructuring
2. Import `ThinkingDelta` type
3. Add `thinking_delta` case before `text_delta`
4. Add thinking finalization at start of `text_delta` case
5. Add cleanup in `done` case
6. Update hook that creates deps to provide the new ref

**Acceptance Criteria**:

- [ ] First thinking_delta creates ThinkingPart with `isStreaming: true`
- [ ] Subsequent thinking_deltas append to existing part
- [ ] First text_delta after thinking finalizes part with `elapsedMs`
- [ ] Parts ordering: thinking before text
- [ ] thinkingStartRef reset in done handler
- [ ] No regression in existing behavior
- [ ] Tests written and passing

---

## Phase 4: UI Components

### Task 4.1: Create ThinkingBlock.tsx component

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 4.2

**Technical Requirements**:

- Four visual states: streaming, collapsing, collapsed, expanded
- Breathing "Thinking..." label with `animate-pulse` during streaming
- "Thought for Xs" chip after completion
- Auto-collapse via `useEffect` when `isStreaming` transitions false
- Cannot collapse during streaming (button disabled)
- Expand/collapse with AnimatePresence animation matching SubagentBlock
- Brain icon from lucide-react
- `max-h-64 overflow-y-auto` on expanded content
- Plain text rendering (pre with whitespace-pre-wrap, no HTML/markdown)
- ARIA: `aria-expanded`, `aria-label`, disabled state

**Implementation Steps**:

1. Create file at `apps/client/src/layers/features/chat/ui/ThinkingBlock.tsx`
2. Implement `formatThinkingDuration()` helper
3. Implement component with auto-collapse useEffect
4. Style following SubagentBlock precedent

**Acceptance Criteria**:

- [ ] Renders streaming state with pulse animation
- [ ] Renders collapsed chip with duration
- [ ] Auto-collapses on streaming completion
- [ ] Expand/collapse toggle works
- [ ] Disabled during streaming
- [ ] ARIA attributes correct
- [ ] Tests written and passing

---

### Task 4.2: Add thinking branch to AssistantMessageContent.tsx parts dispatcher

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1, Task 4.1
**Can run parallel with**: Task 4.1

**Technical Requirements**:

- Import `ThinkingBlock` from `../ThinkingBlock`
- Add `thinking` type check before `text` check in `parts.map()`
- Pass `text`, `isStreaming`, `elapsedMs` props
- Use `_partId` for React key when available, fallback to `thinking-${i}`

**Implementation Steps**:

1. Add import for ThinkingBlock
2. Add thinking branch in parts.map() before text branch

**Acceptance Criteria**:

- [ ] Messages with thinking part render ThinkingBlock
- [ ] Correct order (thinking above text)
- [ ] No regression without thinking parts
- [ ] `pnpm typecheck` passes

---

## Phase 5: Tests

### Task 5.1: Add sdk-event-mapper unit tests for thinking blocks

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: Task 5.2, Task 5.3

6 test cases covering:

- content_block_start(thinking) sets inThinking
- thinking_delta yields event when inThinking
- thinking_delta ignored when not inThinking
- content_block_stop resets inThinking
- Full thinking -> text transition
- No regression on normal text_delta

---

### Task 5.2: Add transcript-parser unit tests for thinking blocks

**Size**: Small
**Priority**: High
**Dependencies**: Task 2.2
**Can run parallel with**: Task 5.1, Task 5.3

5 test cases covering:

- Thinking + text block parsing
- Empty thinking blocks skipped
- Missing thinking field handled
- Part ordering preserved
- No regression without thinking

---

### Task 5.3: Add ThinkingBlock component tests

**Size**: Medium
**Priority**: High
**Dependencies**: Task 4.1
**Can run parallel with**: Task 5.1, Task 5.2

12 test cases covering:

- Streaming label, content visibility
- Collapsed chip text with duration
- Expand/collapse toggle
- ARIA attributes
- Button disabled during streaming
- Duration formatting (<1s, seconds, minutes)
- Data attributes

---

### Task 5.4: Add stream-event-handler tests for thinking_delta

**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: Task 5.1, Task 5.2, Task 5.3

6 test cases covering:

- First thinking_delta creates ThinkingPart
- Append behavior on subsequent deltas
- thinkingStartRef tracking
- Thinking finalization on text_delta
- Part ordering
- Message update callback triggered

---

### Task 5.5: Add AssistantMessageContent integration test for thinking parts

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 4.1, Task 4.2
**Can run parallel with**: Task 5.1, Task 5.2, Task 5.3, Task 5.4

3 test cases covering:

- ThinkingBlock renders for thinking parts
- Correct DOM order (thinking before text)
- No regression without thinking parts
